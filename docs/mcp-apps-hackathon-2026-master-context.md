# 🚀 MCP Apps Hackathon 2026 — Master Context

> **Source:** [notes.yigitkonur.com/ajgpX35zAJaabo](https://notes.yigitkonur.com/ajgpX35zAJaabo)

Reference document for the MCP Apps Hackathon 2026. For the full, up-to-date master context (rules, judging, timeline, resources), open the link above.

---

## 📊 Evaluation Criteria — 100 Points Total

Use this as your build blueprint. Design every decision around maximizing these scores.

### 🥇 Criteria 1 — Originality · PRIMARY · 30 pts

*"I didn't know you could build that as an MCP App."*

- How novel and creative is the concept?
- Avoid generic CRUD tools — push the boundaries of what a chat-native interactive widget can be.

### 🥇 Criteria 2 — Real-World Usefulness · PRIMARY · 30 pts

- Does the app solve a real problem or meaningfully improve a workflow?
- Don't build a toy demo — build something people would actually want to use.

### 🥈 Criteria 3 — Widget–Model Interaction · MEDIUM · 20 pts

- How well does the project use bidirectional communication between the widget and the AI model?
- This is what separates an MCP App from a static embed.
- **Key SDK APIs to use:**

| API | Purpose |
|-----|---------|
| `useCallTool()` | Widget calls a server-side tool |
| `sendFollowUpMessage()` | Widget sends a message back to the model |
| `state()` | Read shared state between widget and model |
| `setState()` | Write shared state between widget and model |

### 🥉 Criteria 4 — User Experience & UI · LOW · 10 pts

- How polished and intuitive is the experience?
- Important for impression, but don't over-invest vs. the top criteria.

### 🥉 Criteria 5 — Production Readiness · LOW · 10 pts

- OAuth, onboarding flow, and any configuration needed on first install.
- Shows you've thought through the real-world setup experience.

---

*This doc was added to the manifold project for quick reference. Update or replace this file if you copy in more content from the source.*
