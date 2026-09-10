---
"executor": patch
---

**Browser control: two Executor Browser extensions can stay connected at once, each with its own tool address**

Connecting a second Chrome, Brave, or Edge no longer replaces the first reverse session. Each extension instance is a catalog connection under `browser` (`tools.browser.user.desktop` for the first unlabeled Chrome, `tools.browser.user.brave` for Brave, and so on). `status` lists every live local browser and its address so an agent can pick the right prefix instead of guessing.
