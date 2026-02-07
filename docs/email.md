# Email Integration

Give your agent its own email inbox and outbox with IMAP + SMTP configuration.

---

## What is Email Integration?

The email connector lets your agent send and receive emails through any IMAP/SMTP provider. Incoming emails are processed as messages and can trigger notifications and webhook events.

---

## Supported Providers

| Provider | IMAP Host | SMTP Host |
|----------|-----------|-----------|
| Gmail | imap.gmail.com:993 | smtp.gmail.com:587 |
| Outlook | outlook.office365.com:993 | smtp.office365.com:587 |
| Custom IMAP | your-server:993 | your-server:587 |

---

## Getting Started

### 1. Generate an app-specific password (Gmail example)

Go to Google Account -> Security -> App Passwords -> Generate. Never use your main Google password.

### 2. Configure via API or the Email tab

```
POST /api/v1/email/configure
Authorization: Bearer <token>

{
  "imapHost": "imap.gmail.com",
  "imapPort": 993,
  "imapUser": "agent@gmail.com",
  "imapPassword": "app-specific-password",
  "imapTls": true,
  "smtpHost": "smtp.gmail.com",
  "smtpPort": 587,
  "smtpUser": "agent@gmail.com",
  "smtpPassword": "app-specific-password",
  "smtpTls": true,
  "fromAddress": "agent@gmail.com",
  "fromName": "My Agent"
}
```

### 3. Test the connection

```
POST /api/v1/email/test
{ "to": "test@example.com" }
```

---

## Security

- **Always use app-specific passwords**, never your main account password
- TLS is strongly recommended for both IMAP and SMTP
- Passwords are transmitted over HTTPS and stored encrypted server-side
- The Email tab masks password fields -- they are never returned by the API

---

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /email/configure | Configure and start the connector |
| POST | /email/stop | Stop the connector |
| GET | /email/status | Get connector status |
| POST | /email/test | Send a test email |

---

## Troubleshooting

**Connection refused / authentication failed**

Verify your credentials. For Gmail, ensure you are using an app-specific password and that IMAP is enabled in Gmail settings.

**Emails not arriving**

Check the poll interval setting. Verify the connector status shows "Running". Check the "Last Error" field.
