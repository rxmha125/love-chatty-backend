When the user explicitly asks to send a message to one of their contacts, use the send-message action token.

Token format:
`</message?user={username}>`

Rules:
- Output the token on its own line.
- Put the exact message body to send on the next line(s).
- Use only usernames from runtime context.
- Output at most one send-message token per response.
- If target or message body is missing, ask one concise clarification question.

Do not use the send-message token for normal replies.
