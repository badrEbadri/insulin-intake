INSULIN INTAKE — TELEGRAM AUTOMATIC BACKUP (FRONTEND ONLY)

BEHAVIOUR
- Whenever a NEW insulin dose or NEW weight measurement is saved successfully,
  the app creates a complete CSV of all insulin and weight records and sends it
  to your Telegram bot chat.
- Editing or deleting a record does not trigger a Telegram upload.
- The upload is silent (disable_notification=true).
- No backend server, hosting function, database, or paid service is used.
- Local saving and local automatic snapshots continue to work even if Telegram fails.

SETUP
1. In Telegram, open @BotFather and send /newbot.
2. Follow the prompts and copy the bot token BotFather gives you.
3. Open your new bot's private chat and press Start (or send /start).
4. Find your numeric chat ID:
   a. Paste your bot token into this URL in your browser:
      https://api.telegram.org/botYOUR_BOT_TOKEN/getUpdates
   b. Find the latest message object and copy message.chat.id.
   c. If getUpdates returns no messages, send /start to the bot and refresh.
5. Open telegram-config.js and replace:
      PASTE_BOT_TOKEN_HERE
      PASTE_CHAT_ID_HERE
   with your actual values. Keep the quotation marks.
6. Upload index.html, app.js, styles.css, and telegram-config.js together to the
   same folder on your existing HTTPS website. Keep your existing manifest,
   service-worker.js, and icon assets too.

IMPORTANT LIMITATIONS
- The bot token is public in frontend code and browser network requests. Anyone
  who can inspect the website can copy it and send messages through your bot.
  Use a dedicated personal bot, restrict its use, and revoke/regenerate the token
  with @BotFather if it is exposed or misused.
- Bots cannot send a message to your personal Telegram "Saved Messages".
  The backup arrives in the private conversation with the bot.
- The app must be open, running, and online when you save the new record.
  Browser background restrictions mean it cannot guarantee a backup after the
  app is closed or suspended.
- This browser-only request uses fetch with mode=no-cors and multipart form data.
  The browser hides Telegram's response, so the app cannot verify whether the
  upload succeeded. Check the bot chat for the CSV.
- Backups contain the complete history, including notes. They are sensitive
  health information. Keep the bot chat private and enable Telegram account
  security.
- Telegram's free Bot API is used; normal Telegram rate limits still apply.
