this happen when I use through rayu host provider through ollama glm5.2 it show this issue and Please find the root cause and fix it but you know when it accident stopping the streamming you thinking the thinking status is remain working it not update the staus so it make the user confuse that it still working  and you see the status "◇ Rayu cogitated for 6m 56s" is stay top of thinking which is wrong it must the ending response is stay and the last so that the user can view and see the rayu code is done response or stop response.
 Read 1 file (ctrl+o to expand)
  ⎿  API Error: Streaming is required for operations that may take longer than 10 minutes. See https://github.com/anthropics/anthropic-sdk-typescript#long-requests for more
◇ Rayu cogitated for 6m 56s

⠁ Thinking…
  This is an arrow function (=>), so there's no `{` `}` body — just the expression. The `));` on line 192 closes the `Future.delayed(...)` call. Then `}` on line 193 should
   close the class. But I added `getCommissionRate` after that `}`.
  Wait, but `getStats` is declared with `=>` (arrow), so there's no method body `{}`. The `}` at line 193 is closing the CLASS, not the method. So `getCommissionRate` is
  (ctrl+o to expand)







  Second Bug: when the user use the modle that don't support the tool and when the user past the tool it will show the error so please change the error to tell the user is model not support image upload or tell me hwo to handle with that mostly this happen with deepseek because deepseek don't support image 
  ❯ built in tool
  ⎿  ⧉ Selected 1 lines from ../../../../tmp/rayu_ghost.log in Visual Studio Code
  ⎿  API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"this model does not support image input (ref:
     d2ab84d0-97d7-487c-9c4a-b0e8cfbe8e50)"},"request_id":"req_ec917690865518c50be2f910"}
NOte ONly this deepseek or the model that not support image not all the model is not rayu-cli issue it the LLM provider issue 