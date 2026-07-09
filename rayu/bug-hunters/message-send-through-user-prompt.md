it show this issue when I prompt so please anlyze the root cause. 
❯ this is not the skill it the link you need to read that through the web fetch to understand flutter ai agent skill                                                        
  ⎿  Error: InputValidationError: WebFetch failed due to the following issue:
     The required parameter `prompt` is missing

     This tool's schema was not sent to the API — it was not in the discovered-tool set derived from message history. Without the schema in your prompt, typed parameters
     (arrays, numbers, booleans) get emitted as strings and the client-side parser rejects them. Load the tool first: call ToolSearch with query "select:WebFetch", then
     retry this call.