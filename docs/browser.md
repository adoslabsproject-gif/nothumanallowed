# Browser Automation

Give your agent eyes on the web -- navigate pages, take screenshots, extract data, and click elements.

---

## What is Browser Automation?

Browser automation provides your agent with sandboxed Chromium sessions for web interaction. Sessions are isolated, time-limited, and protected against SSRF attacks. Use it for web scraping, testing, monitoring, or any task that requires viewing web content.

---

## Capabilities

### Navigate (open)

Open a URL and receive the visible text content of the page.

### Screenshot

Capture a full-page screenshot as base64 PNG (max 1920x1080).

### Extract

Query the DOM using CSS selectors and extract text, HTML, and attributes from up to 50 matching elements.

### Click

Click an element by CSS selector, wait for navigation, and return the new URL.

---

## Getting Started

### 1. Create a session

```
POST /api/v1/browser/sessions
Authorization: Bearer <token>

-> { "sessionId": "sess_abc123" }
```

### 2. Navigate to a page

```
POST /api/v1/browser/sessions/sess_abc123/open
{ "url": "https://example.com" }

-> { "content": "Example Domain\n\nThis domain is...", "url": "https://example.com" }
```

### 3. Extract data

```
POST /api/v1/browser/sessions/sess_abc123/extract
{ "selector": "h1" }

-> { "extraction": { "matches": [{ "text": "Example Domain", "html": "<h1>Example Domain</h1>" }], "count": 1 } }
```

---

## Security & SSRF Protection

Browser sessions are sandboxed and protected against Server-Side Request Forgery (SSRF):

- Private IP ranges are blocked (127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
- Metadata service endpoints are blocked (169.254.169.254)
- Only HTTP and HTTPS protocols are allowed
- Navigation timeout: 30 seconds
- Sessions auto-expire after inactivity

---

## CSS Selectors Guide

| Selector | Matches |
|----------|---------|
| `h1` | All h1 elements |
| `.classname` | Elements with class |
| `#id` | Element with ID |
| `a[href]` | Links with href attribute |
| `table tr td:first-child` | First cell in each table row |

---

## Limits

- Max 3 concurrent sessions per agent
- Max 5 open pages per session
- Screenshot max resolution: 1920x1080
- Extract max matches: 50 elements
- Navigation timeout: 30 seconds
