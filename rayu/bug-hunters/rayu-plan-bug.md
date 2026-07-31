fixed: 
the feature is allow free plan user to use all unlimited except only these features: 
- Collaborator swarms
- Collaborator model
- subagent models
- Native Image & Video generation tools
- Telegram bot remote control
- P2P Direct Connect
- Absolute Privacy: No Training Data
but it show the bug is my account is also the pro (10$) but it still said like below is require paid plan since I have the credit so I think the issue is because the mutiple api key rotate but it return 403 from the rayu-gateway but the model is will response so I don't the root case so please find the root cause and fix it. 
this si the proof: 
● Fetch(url: "https://docs.flutter.dev/ai/agent-skills", prompt: "Extract the complete guidance for Flutter AI agent skills. Include: how agents should work with Flutter
       code, what conventions to follow, how to handle widgets/state/navigation, any example prompts or rules, and how to apply these guidelines in a real project.")
  ⎿  Received 62.9KB (200 OK)
API Error: 403 {"error":{"message":"🔒 Rayu-hosted models are a paid feature. Please upgrade your plan to use them:
https://rayucode.com/plans","type":"upgrade_required","code":"plan_upgrade_required"}}

                                                                                                                                       11:33 AM kimi-k2.7-code:cloud
● I cannot fetch that URL — WebFetch is returning a paid-feature error on this plan. I also don't have a general web search tool available right now.

this is not happen in this case it happen in when I use this model doing sometime I can't defined or tell you the exact isue but I tell current it have in above one case and the second is is when i use the subagent planner and it write to the file it said like issue in that writing the file "API Error: 403 {"error":{"message":"🔒 Rayu-hosted models are a paid feature. Please upgrade your plan to use them: https://rayucode.com/plans","type":"upgrade_required","code":"plan_upgrade_required"}}
"


# bug 2 (root cuase maybe because the concurrent each user request) to fixed to just make the concurrent is changable in teh system admin
it show this issue but I have the credits 

● 💳 You've reached your plan's credit limit for this billing period. Your credits renew
  in about 26 days. Renew or upgrade your plan, or add more credits, to keep using
  Rayu-hosted models: https://rayucode.com/plans — or run /model to switch to a model on
  another provider (e.g. your own API key).

❯ /usage                                                                                 
  ⎿  Rayu Plan Usage

       Plan     Max ($50/mo)

       Credits  [███████████░░░░░░░░░░░] 50%
                148.7 / 300 used · 151.3 left · resets in 26d 1h

       Tokens   [███████████░░░░░░░░░░░] 50%
                148,696,348 / 300,000,000
                                                                                         
       Top-up   0 credits







#bug 3
2026/07/31 10:36:45 hosted done: user=5 reqid=ad2bfe8c-fb7c-485c-9627-af88795c84c7 source=repl_main_thread model=glm-5.2 billable=0 (est 126120) via=plan (no usage reported)
2026/07/31 10:36:45 anthropic: upstream error user=5 reqid=ad2bfe8c-fb7c-485c-9627-af88795c84c7 source=repl_main_thread model=glm-5.2 format=anthropic_messages wrote=false: Post "https://ollama.com/v1/messages": context canceled
2026/07/31 10:36:45 POST /anthropic/v1/messages -> 502 (3.281s, 161B)
2026/07/31 10:36:49 anthropic: user=5 reqid=ce34cbcf-0d3e-4de6-ad34-d82e467cfe97 source=repl_main_thread model=glm-5.2 provider=rayu-ollama format=anthropic_messages intended="glm-5.2" stream=true reserved=126120
2026/07/31 10:37:19 hosted done: user=5 reqid=ce34cbcf-0d3e-4de6-ad34-d82e467cfe97 source=repl_main_thread model=glm-5.2 billable=0 (est 126120) via=plan (no usage reported)
2026/07/31 10:37:19 anthropic: upstream error user=5 reqid=ce34cbcf-0d3e-4de6-ad34-d82e467cfe97 source=repl_main_thread model=glm-5.2 format=anthropic_messages wrote=false: Post "https://ollama.com/v1/messages": http2: timeout awaiting response headers
2026/07/31 10:37:19 POST /anthropic/v1/messages -> 502 (30.022s, 161B)