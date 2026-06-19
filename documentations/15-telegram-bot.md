# 15. Telegram Bot & Bridge

The Telegram Bot feature allows you to link a Telegram bot directly to your Rayu-CLI session, enabling you to drive the CLI and interact with the REPL remotely from your phone or any Telegram client.

---

## How It Works

Rayu-CLI runs an in-process **Telegram Bridge** that polls the Telegram Bot API directly (with no intermediate server) to receive your messages, run them inside the Rayu session, and stream the responses (including text, thinking blocks, and media assets) back to your Telegram chat.

---

## Setup & Pairing

### Step 1: Create a Bot via @BotFather
1. Open Telegram and search for the official **@BotFather** bot.
2. Send the command `/newbot` to start the bot creation process.
3. Choose a name and username for your bot.
4. Copy the **HTTP API Bot Token** provided by BotFather (looks like: `123456789:ABCDefGHI...`).

### Step 2: Connect the Bot in Rayu
1. Inside your Rayu-CLI interactive session, run the slash command:
   ```
   /telegram-bot
   ```
2. Paste your Bot Token when prompted.
3. The CLI will securely save the token and display a **QR Code** along with a deep link to start pairing.

### Step 3: Link your Chat
1. Scan the QR code or click the deep link (`https://t.me/<bot_username>?start=<pairToken>`) to open your bot in Telegram.
2. Press **Start** (or send `/start <pairToken>`).
3. Once linked, the Rayu CLI session will automatically detect the connection, activate the bridge, and close the pairing dialog.

---

## Remote Commands

Once connected, you can interact with the bot in Telegram using normal prompts or special bot commands:
* **Prompts:** Just send any prompt (e.g., "explain this project" or "write a quicksort function in python") as if you were typing in the local CLI.
* **`/context`**: Show context-window usage.
* **`/cost`**: Show token usage and cost for the session.
* **`/compact`**: Summarize and compact the conversation to free context.
* **`/clear`**: Clear conversation history and reset.

---

## Unlinking / Disconnecting

To disconnect and stop the Telegram bridge, run this command in your CLI session:
```
/disconnect-telegram
```
This will securely unlink your Telegram chat from the CLI session and stop all background polling.
