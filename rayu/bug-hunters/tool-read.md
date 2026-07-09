When the AI use the tool read sometimes it error this: 

● Read(/home/rayu/H2H-V1/docs/design-system.md)
  ⎿  Read 330 lines
  ⎿  Error: InputValidationError: TaskUpdate failed due to the following issues:
     The required parameter `taskId` is missing
     An unexpected parameter `task_id` was provided

     This tool's schema was not sent to the API — it was not in the discovered-tool set derived from message history. Without the schema in your prompt, typed parameters
     (arrays, numbers, booleans) get emitted as strings and the client-side parser rejects them. Load the tool first: call ToolSearch with query "select:TaskUpdate", then
     retry this call.