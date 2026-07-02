# Requirements Document

## Introduction

`rayucode` is an editor extension that surfaces the existing Rayu CLI (a terminal-based, multi-provider AI coding agent published as `@rayu-dev/rayu-cli`, binary `rayu`) inside a code editor. The first and primary target is Visual Studio Code (VS Code), but the architecture must isolate editor-specific code behind an abstraction layer so that the core integration can be reused to build extensions for additional editors later.

The extension lets a developer drive the Rayu agent from within the editor through an interactive chat/agent panel, while keeping the agent's existing strengths: multi-provider support, the built-in tool suite, MCP, skills, and reuse of credentials and configuration stored in `~/.rayu/`. The extension does not reimplement the agent; it spawns and supervises the existing `rayu` process and communicates with it over its programmatic streaming control protocol (the `--print --input-format=stream-json --output-format=stream-json --verbose` bidirectional NDJSON channel exposed by the CLI), rendering the agent's output and routing tool/permission decisions back to the user.

This document defines the functional and quality requirements for `rayucode` using EARS patterns. Implementation choices (exact protocol framing, webview framework, transport selection) are described as constraints only where they are externally observable behavior; the design document will detail the mechanisms.

## Glossary

- **Rayu_CLI**: The existing terminal AI coding agent binary (`rayu`, npm package `@rayu-dev/rayu-cli`) located at `/home/rayu/rayu-cli/rayu`. Not built by this feature.
- **Rayu_Agent_Process**: A running instance of Rayu_CLI launched in headless/streaming mode by the extension to service a session.
- **Extension**: The `rayucode` editor extension as a whole, including the editor-specific host and the editor-agnostic core.
- **Core_Integration**: The editor-agnostic layer of the Extension that manages Rayu_Agent_Process lifecycle, the control protocol, session state, and message streaming.
- **Editor_Host**: The editor-specific layer of the Extension that implements the Editor_Adapter for a concrete editor (the first being VS Code).
- **Editor_Adapter**: The interface contract between Core_Integration and an Editor_Host (UI surfaces, file edit application, workspace queries, command registration, secret storage).
- **VSCode_Host**: The concrete Editor_Host implementation for VS Code.
- **Agent_Panel**: The interactive chat/agent UI surface rendered inside the editor (a webview in VS Code) where the user converses with the agent and reviews its actions.
- **Control_Protocol**: The bidirectional newline-delimited JSON (NDJSON) message channel between Core_Integration and Rayu_Agent_Process over the process stdin/stdout, comprising agent messages, `control_request`, `control_response`, permission requests, and hook events.
- **Session**: One logical conversation thread between the user and the agent, backed by one Rayu_Agent_Process and an ordered history of messages.
- **Tool_Action**: A discrete operation the agent requests, such as a file write, file read, or bash command execution, surfaced through the Control_Protocol.
- **Permission_Request**: A Control_Protocol message in which Rayu_Agent_Process asks the user to approve or deny a Tool_Action before execution.
- **Permission_Mode**: A user-selectable policy that determines which Tool_Action categories require explicit per-action approval.
- **File_Edit_Proposal**: A set of file changes the agent proposes, expressed as a before/after diff per file, that the user can review and apply into the editor workspace.
- **Provider**: An AI backend supported by Rayu_CLI (anthropic, openai-compatible, bedrock, vertex, rayu-hosted).
- **Model**: A specific model offered by a connected Provider.
- **Rayu_Config_Dir**: The on-disk configuration and credential directory used by Rayu_CLI, located at `~/.rayu/`.
- **Workspace_Context**: The set of editor state the agent may use: the workspace root folder(s), the active file path, the active text selection, and the list of open editors.
- **MCP_Server**: A Model Context Protocol server that Rayu_CLI can connect to, configured in Rayu_Config_Dir or extension settings.
- **Skill**: A reusable Rayu_CLI skill available to the agent.
- **Marketplace**: The Visual Studio Code Marketplace used for distribution of VSCode_Host.

## Requirements

### Requirement 1: Detect and locate the Rayu CLI

**User Story:** As a developer, I want the Extension to find or be told where the Rayu CLI is installed, so that the agent can run without manual configuration in the common case.

#### Acceptance Criteria

1. WHEN the Extension activates, THE Core_Integration SHALL resolve a path to the Rayu_CLI executable by checking, in order, an explicit extension setting, then the system PATH.
2. IF no Rayu_CLI executable is resolved during activation, THEN THE Extension SHALL display an actionable message that states the Rayu_CLI was not found and offers a way to set the executable path.
3. WHERE the user has set an explicit Rayu_CLI executable path in extension settings, THE Core_Integration SHALL use that path in preference to the PATH-resolved executable.
4. WHEN a Rayu_CLI executable is resolved, THE Core_Integration SHALL query the executable version using the `--version` flag and record the reported version string for the Session.
5. IF the resolved Rayu_CLI reports a version below the minimum version the Extension requires, THEN THE Extension SHALL display a message identifying the detected version and the minimum required version and SHALL allow the user to continue operating with the incompatible version.
6. WHERE no Rayu_CLI executable was resolved, THE Extension SHALL NOT display a version-compatibility message.

### Requirement 2: Start and manage the agent process

**User Story:** As a developer, I want the Extension to start and supervise the Rayu agent process for a session, so that I do not have to manage a terminal process myself.

#### Acceptance Criteria

1. WHEN the user opens the Agent_Panel for a workspace without an active Session, THE Core_Integration SHALL start one Rayu_Agent_Process for that Session in headless streaming mode.
2. THE Core_Integration SHALL launch each Rayu_Agent_Process with the streaming control mode enabled (NDJSON input and output over the process stdin and stdout).
3. THE Core_Integration SHALL set the working directory of each Rayu_Agent_Process to the workspace root folder associated with the Session.
4. WHEN a Session is closed by the user, THE Core_Integration SHALL terminate the Rayu_Agent_Process associated with that Session and SHALL release its resources only after confirming that the process has terminated.
5. IF a Rayu_Agent_Process exits unexpectedly while a Session is open, THEN THE Extension SHALL display the exit status in the Agent_Panel and offer a control to restart the Session.
6. WHILE a Rayu_Agent_Process is running, THE Core_Integration SHALL route process stderr output to an extension log channel separate from the Agent_Panel conversation.
7. WHEN the editor window is closed, THE Core_Integration SHALL terminate every Rayu_Agent_Process the Extension started.

### Requirement 3: Interactive chat and agent panel

**User Story:** As a developer, I want an interactive chat panel inside the editor, so that I can converse with the agent and see its work without leaving the editor.

#### Acceptance Criteria

1. WHEN the user invokes the open-panel command, THE Editor_Host SHALL display the Agent_Panel within the editor.
2. WHEN the user submits a prompt in the Agent_Panel, THE Core_Integration SHALL send the prompt to the Rayu_Agent_Process over the Control_Protocol.
3. WHEN the Rayu_Agent_Process emits an assistant message over the Control_Protocol, THE Agent_Panel SHALL display the message content.
4. THE Agent_Panel SHALL display each message in the Session in the order the Core_Integration received the corresponding Control_Protocol message.
5. WHILE the Rayu_Agent_Process is generating a response, THE Agent_Panel SHALL display an indicator that a response is in progress and SHALL provide a control to interrupt the in-progress response.
6. WHEN the user activates the interrupt control, THE Core_Integration SHALL send an interrupt request to the Rayu_Agent_Process over the Control_Protocol.
7. THE Agent_Panel SHALL render assistant message content that uses Markdown formatting as formatted output, and SHALL render fenced code blocks with monospaced formatting.

### Requirement 4: Stream incremental responses

**User Story:** As a developer, I want to see the agent's response appear incrementally, so that I get feedback before the full response is complete.

#### Acceptance Criteria

1. WHEN the Rayu_Agent_Process emits partial assistant message content over the Control_Protocol, THE Agent_Panel SHALL append the partial content to the in-progress message.
2. WHEN the Rayu_Agent_Process emits the terminal result message for a prompt over the Control_Protocol, THE Agent_Panel SHALL mark the in-progress message as complete.
3. IF the Control_Protocol stream produces a line that is not valid JSON, THEN THE Core_Integration SHALL record the line to the extension log channel and SHALL continue processing subsequent lines.
4. WHEN the Rayu_Agent_Process reports token usage or cost information for a completed prompt over the Control_Protocol, THE Agent_Panel SHALL display the reported usage for that response.

### Requirement 5: Tool action permission handling

**User Story:** As a developer, I want to approve or deny the agent's tool actions, so that I stay in control of changes to my system and files.

#### Acceptance Criteria

1. WHEN the Rayu_Agent_Process sends a Permission_Request over the Control_Protocol, THE Agent_Panel SHALL display the requested Tool_Action and its parameters and SHALL present approve and deny controls.
2. WHEN the user approves a Permission_Request, THE Core_Integration SHALL send an allow Permission_Response containing the approved Tool_Action input to the Rayu_Agent_Process over the Control_Protocol.
3. WHEN the user denies a Permission_Request, THE Core_Integration SHALL send a deny Permission_Response to the Rayu_Agent_Process over the Control_Protocol.
4. WHERE the active Permission_Mode designates a Tool_Action category as auto-approved, THE Core_Integration SHALL respond to a Permission_Request for that category with an allow Permission_Response without prompting the user.
5. IF a Permission_Request remains unanswered when its Session is closed, THEN THE Core_Integration SHALL send a deny Permission_Response for that request before terminating the Rayu_Agent_Process.
6. WHEN a Permission_Request describes a bash command Tool_Action, THE Agent_Panel SHALL display the exact command string before the user approves or denies the request.

### Requirement 6: Apply file edits into the editor

**User Story:** As a developer, I want the agent's proposed file edits applied into my workspace with a chance to review them, so that I can accept changes safely.

#### Acceptance Criteria

1. WHEN the Rayu_Agent_Process proposes a File_Edit_Proposal over the Control_Protocol, THE Agent_Panel SHALL present the proposal as a per-file before/after diff.
2. WHEN the user approves a File_Edit_Proposal, THE Editor_Host SHALL apply the proposed changes to the corresponding files in the workspace.
3. WHEN the user approves a File_Edit_Proposal, IF a target file of that proposal has been modified on disk since the proposal was generated, THEN THE Extension SHALL display a conflict notice identifying the file and SHALL require explicit user confirmation before applying the change to that file.
4. WHEN the Editor_Host applies a File_Edit_Proposal that targets a file open in an editor tab, THE Editor_Host SHALL update the open editor buffer for that file.
5. WHEN the Editor_Host applies a File_Edit_Proposal that creates a new file, THE Editor_Host SHALL create the file at the path specified in the proposal relative to the workspace root.
6. IF applying any file in a File_Edit_Proposal fails, THEN THE Extension SHALL display the failure with the affected file path and SHALL leave the remaining unaffected files unchanged.

### Requirement 7: Provider and model selection

**User Story:** As a developer, I want to choose the provider and model from inside the editor, so that I can switch backends without using the terminal.

#### Acceptance Criteria

1. THE Agent_Panel SHALL display the Provider and Model currently in effect for the active Session.
2. WHEN the user opens the model selection control, THE Core_Integration SHALL request the list of available Models from the Rayu_Agent_Process over the Control_Protocol and THE Agent_Panel SHALL display the returned Models.
3. WHEN the user selects a Model from the model selection control, THE Core_Integration SHALL send a set-model request for the selected Model to the Rayu_Agent_Process over the Control_Protocol.
4. IF the Rayu_Agent_Process reports that a requested Model is unavailable, THEN THE Agent_Panel SHALL display the reported reason and SHALL retain the previously effective Model.

### Requirement 8: Reuse Rayu CLI authentication and configuration

**User Story:** As a developer, I want the Extension to reuse the credentials and configuration I already set up with the Rayu CLI, so that I do not have to authenticate again.

#### Acceptance Criteria

1. THE Core_Integration SHALL launch each Rayu_Agent_Process with the same Rayu_Config_Dir that the Rayu_CLI uses by default.
2. WHERE the user has connected a Provider through the Rayu_CLI prior to using the Extension, THE Core_Integration SHALL allow the Rayu_Agent_Process to use that Provider's stored credentials without prompting for re-authentication in the Extension.
3. IF the Rayu_Agent_Process reports an authentication failure for the active Provider over the Control_Protocol, THEN THE Agent_Panel SHALL display the reported authentication failure and SHALL state that the user can connect the Provider using the Rayu_CLI.
4. THE Extension SHALL NOT write Provider credentials it obtains to any location other than the secret storage facility provided by the Editor_Host or the Rayu_Config_Dir managed by the Rayu_CLI.

### Requirement 9: Workspace and editor context awareness

**User Story:** As a developer, I want the agent to be aware of what I am working on, so that its responses are relevant to my current file and selection.

#### Acceptance Criteria

1. WHEN the user submits a prompt, THE Core_Integration SHALL include the workspace root folder path of the active Session in the Workspace_Context sent to the Rayu_Agent_Process.
2. IF the workspace root folder of the active Session cannot be determined, THEN THE Core_Integration SHALL send the submitted prompt without a workspace root folder path in the Workspace_Context.
3. WHERE the user has enabled inclusion of the active file, THE Core_Integration SHALL include the active file path in the Workspace_Context sent with a submitted prompt.
4. WHERE the user has enabled inclusion of the active selection, THE Core_Integration SHALL include the active text selection content and its file path in the Workspace_Context sent with a submitted prompt.
5. WHEN the user invokes the add-selection-to-prompt command while a text selection exists, THE Editor_Host SHALL insert a reference to the selected text and its file path into the Agent_Panel prompt input.
6. THE Editor_Host SHALL NOT include the contents of files excluded by the workspace ignore configuration in the Workspace_Context unless the user explicitly references such a file.

### Requirement 10: Bash and tool execution with approval

**User Story:** As a developer, I want bash and tool actions the agent runs to be visible and gated by approval, so that the agent cannot run commands silently.

#### Acceptance Criteria

1. WHEN the Rayu_Agent_Process executes a Tool_Action after approval, THE Agent_Panel SHALL display the Tool_Action and its result in the Session history.
2. WHEN a bash Tool_Action produces output over the Control_Protocol, THE Agent_Panel SHALL display the output associated with that Tool_Action.
3. WHILE a bash Tool_Action is running, THE Agent_Panel SHALL display a running indicator for that Tool_Action.
4. WHERE the active Permission_Mode requires approval for bash Tool_Actions, THE Core_Integration SHALL withhold execution of a bash Tool_Action until the user approves the corresponding Permission_Request.

### Requirement 11: MCP and skills integration

**User Story:** As a developer, I want the agent's MCP servers and skills to work inside the editor, so that I retain the agent's full capabilities.

#### Acceptance Criteria

1. THE Core_Integration SHALL launch each Rayu_Agent_Process such that MCP_Servers configured in the Rayu_Config_Dir are available to the agent.
2. WHEN the Rayu_Agent_Process reports the connection status of an MCP_Server over the Control_Protocol, THE Agent_Panel SHALL display the reported status for that MCP_Server.
3. WHERE a Skill is available to the Rayu_Agent_Process, THE Core_Integration SHALL allow the agent to invoke that Skill without additional configuration in the Extension.
4. IF a Skill that was previously available becomes unavailable to the Rayu_Agent_Process, THEN THE Extension MAY require additional configuration before that Skill can be invoked again.
5. IF an MCP_Server fails to connect as reported by the Rayu_Agent_Process, THEN THE Agent_Panel SHALL display the reported failure and the affected MCP_Server name.

### Requirement 12: Session persistence and resumption

**User Story:** As a developer, I want my conversation to persist within an editor session, so that I can continue where I left off after closing and reopening the panel.

#### Acceptance Criteria

1. WHILE a Session is active, THE Core_Integration SHALL retain the ordered message history of that Session.
2. WHEN the user closes and reopens the Agent_Panel without closing the Session, THE Agent_Panel SHALL display the retained message history of that Session.
3. IF retrieval of the retained message history fails when the Agent_Panel reopens, THEN THE Agent_Panel SHALL open with an empty message history rather than failing to open.
4. WHEN the user starts a new Session, THE Core_Integration SHALL create an empty message history independent of any prior Session.
5. WHERE the Rayu_Agent_Process exposes a resumable session identifier over the Control_Protocol, THE Core_Integration SHALL record that identifier for the Session.

### Requirement 13: Editor-agnostic abstraction layer

**User Story:** As a maintainer, I want the editor-specific code separated from the core integration, so that future editor extensions can reuse the core without changes.

#### Acceptance Criteria

1. THE Core_Integration SHALL depend only on the Editor_Adapter interface and SHALL NOT reference any VS Code specific application programming interface.
2. THE VSCode_Host SHALL implement every operation declared by the Editor_Adapter interface.
3. THE Editor_Adapter SHALL declare operations for displaying the Agent_Panel, applying a File_Edit_Proposal, querying the Workspace_Context, registering editor commands, and storing and retrieving secrets.
4. WHEN the Core_Integration requires an editor operation, THE Core_Integration SHALL invoke that operation through the Editor_Adapter interface rather than through any editor-specific dependency.
5. THE Core_Integration package SHALL build successfully without any VS Code dependency present.

### Requirement 14: Extension packaging and distribution

**User Story:** As a developer, I want to install rayucode from the VS Code Marketplace, so that installation and updates are simple.

#### Acceptance Criteria

1. THE VSCode_Host SHALL include an extension manifest that declares the open-panel command, the add-selection-to-prompt command, and the configurable Rayu_CLI executable path setting.
2. THE Extension SHALL be packageable into a single installable VS Code extension artifact.
3. THE extension manifest SHALL declare the minimum VS Code version the Extension supports.
4. WHEN the Extension is installed from the Marketplace and activated in a workspace, THE Extension SHALL register the open-panel command so that the command is invocable from the editor command palette.
5. IF registration of an editor command fails during activation, THEN THE Extension SHALL continue running and SHALL record the registration failure to the extension log channel.
6. THE VSCode_Host SHALL declare its activation such that the Extension does not activate until the user invokes a rayucode command or opens the Agent_Panel.

### Requirement 15: Error handling and diagnostics

**User Story:** As a developer, I want clear errors and a log I can inspect, so that I can diagnose problems with the agent integration.

#### Acceptance Criteria

1. IF the Core_Integration cannot start a Rayu_Agent_Process, THEN THE Extension SHALL display the failure reason and SHALL offer a retry control.
2. WHEN the Core_Integration receives a Control_Protocol error message from the Rayu_Agent_Process, THE Agent_Panel SHALL display the error message text.
3. THE Extension SHALL write Control_Protocol traffic and process lifecycle events to an extension log channel when diagnostic logging is enabled in extension settings.
4. IF the Rayu_Agent_Process becomes unresponsive to a sent prompt for longer than a configured timeout, THEN THE Extension SHALL display a notice that the agent is unresponsive and SHALL offer a control to interrupt or restart the Session.
5. THE Extension SHALL NOT display Provider credentials in the Agent_Panel or the extension log channel in any form, including masked or partially obfuscated forms.
