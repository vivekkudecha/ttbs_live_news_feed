# Application Security Readiness Information

**Application:** TTBS Live News Feed  
**Environment for assessment:** UAT

> Items marked `[TO FILL: ...]` need input from the application owner before submission.

## Contact

| Field | Response |
|---|---|
| Name of the contact person * | [TO FILL: contact name] |
| Contact No * | [TO FILL: phone number] |
| Email * | [TO FILL: email address] |

## Application / Assessment Details

| S. No. | Item | Customer response |
|---|---|---|
| 1 | Application Name * | TTBS Live News Feed |
| 2 | Application Description | An internal web application that researches business news about the companies ("logos") in an uploaded Excel/CSV list, then sends each account manager (PAM) a digest about their own companies.<br>Flow: an authorised user uploads a dataset of logos mapped to PAMs, then starts a research run. Background workers ask an LLM provider (Perplexity or Google Gemini, with web search) for recent signals about each logo, such as funding, leadership changes, expansion and tenders. The results are stored, grouped into one digest per PAM and delivered by email (Microsoft Graph) or WhatsApp.<br>Supporting modules: dashboard, signals, runs, schedules, companies, PAMs, uploads, providers & channels, email templates and outbox, costs (FinOps), telemetry, a hash-chained audit log, and user & access management.<br>Stack: React 19 SPA, FastAPI (Python 3.12) REST API, Celery workers, MySQL 8.4 and Redis 7.4, behind an nginx gateway. Deployed as containers (Podman). |
| 3 | Expectation from Assessment * | A full VAPT (web application and API) of the UAT environment against OWASP Top 10 / OWASP ASVS and the OWASP API Security Top 10, before go-live.<br>Please cover in particular: authentication and session management, authorisation (horizontal and vertical privilege escalation between the admin and member roles, and module-level view/manage permissions), CSRF protection, file upload handling (Excel/CSV), injection (SQL and template/prompt injection through uploaded data and email templates), security headers and rate limiting.<br>Deliverable: a report with findings rated by severity, steps to reproduce, and remediation guidance, plus a re-test after fixes. |

## Application Scan Details

| S. No. | Item | Customer response |
|---|---|---|
| 1 | URL(s) of the Application * | UAT: [TO FILL: UAT URL, e.g. http://<uat-host>:<port>/]<br>Note: the UAT gateway is currently bound to 127.0.0.1:5175 on the application server. It can be reached through an SSH tunnel (ssh -L 5175:localhost:5175 <user>@<server>), or the binding can be opened to the tester's source IPs for the testing window.<br>API base path: <UAT URL>/api/v1/ |
| 2 | URL(s) out of scope (important ones) | /phpmyadmin/ : database admin panel (dev/UAT only, not part of the production image; protected by a gateway password gate and MySQL credentials).<br>Third-party services the application calls: Perplexity API, Google Gemini API, Microsoft Graph / Entra ID login endpoints, WhatsApp provider. These must not be tested. |
| 3 | Login Credentials for the App * | Shared separately over a secure channel (not in this document):<br>Admin role: 2 accounts.<br>Member role: 2 accounts (one with "view" on all modules, one with "manage" on selected modules).<br>Note: new and reset accounts get a one-time temporary password and must set a new one at first sign-in. |
| 4 | Is MFA present and enabled? | No. Sign-in is username + password. MFA / company SSO (OIDC) is on the roadmap. |
| 5 | Test with lowest-privileged credentials? | Yes. Objective: confirm that a member user can only open the modules, and do only the actions (view = read, manage = create/change/delete/start/cancel), that an admin granted them. A member must never reach user management (/api/v1/users/*), other users' data, or any admin-only function, whether through the UI or by calling the API directly. |
| 6 | Type of authentication | Form-based (username + password) against the application's own user store. On success the server issues an opaque session token in an HttpOnly, Secure, SameSite=Strict cookie (ttbs_session). State-changing requests must also send a per-session CSRF token in the X-CSRF-Token header. Passwords are hashed with Argon2id.<br>Roles: Admin and Member. Two credentials per role will be provided. |
| 7 | Adequate test data supplied? | Yes. UAT is pre-loaded with sample companies (logos), PAMs, uploads, research runs and signals.<br>Dependency: the Uploads module needs an Excel (.xlsx) or CSV file in the expected template (logo/company plus its PAM). A sample template file will be provided with the credentials.<br>Starting a research run calls a paid LLM API. Please limit run starts (see Hosting Details, item 5). |

## Technical Details

| S. No. | Item | Customer response |
|---|---|---|
| 1 | No. of static & dynamic pages * | Approx. 22 screens in one single-page application.<br>Static / read-only (about 6): Dashboard, Telemetry, Audit log, Costs, Run detail, Job detail.<br>Dynamic / with input (about 16): Login, Change password, Uploads, Companies (list and detail), PAMs, Research runs, Schedules (list, new, edit), Providers & channels, Email templates, Email outbox, Users & access. |
| 2 | How many types of users? * | 2 roles:<br>Admin: full access to every module, including user management (create users, set per-module permissions, reset passwords, unlock accounts, sign users out, deactivate users).<br>Member: access only to the modules an admin grants, each at "view" (read-only) or "manage" (create/change/delete/start/cancel) level. Modules: dashboard, signals, runs, companies, PAMs, uploads, providers & channels, costs, telemetry, audit. |
| 3 | Average input fields per screen * | Approx. 5 to 8. Most are text inputs, search and filter boxes, dropdowns, and checkboxes (permission matrix). Also: password fields, an Excel/CSV file upload, a text editor for email templates and the research prompt, and schedule time/date settings. |
| 4 | Financial transactions involved? *<br>PII / sensitive data handled? * | Financial transactions: No. The Costs (FinOps) module only tracks the application's own LLM API spend against a monthly budget cap. No payments are processed.<br>PII / sensitive data: Yes, limited business data: application users' names and usernames, PAM names, business email addresses and phone numbers (for digest delivery), and company names. Also stored: LLM provider API keys and Microsoft Graph credentials.<br>Protection: passwords hashed with Argon2id (never stored or logged in clear text); provider API keys encrypted with AES-256-GCM; only a SHA-256 hash of each session token is stored; API responses are sent with Cache-Control: no-store. TLS is terminated in front of the gateway in production. |
| 5 | Browsers, Database, Web/App Server versions | Browsers: current Google Chrome, Microsoft Edge and Mozilla Firefox.<br>Database: MySQL 8.4.13 (LTS); Redis 7.4.12 (task broker and cache).<br>Web server: nginx 1.30.6 (nginx-unprivileged, Alpine).<br>App server: Python 3.12, FastAPI on Uvicorn, Celery 5 workers; SQLAlchemy 2 + Alembic.<br>Frontend: React 19.3, React Router 7.18, Vite 6.4 (build tool only).<br>Container runtime: Podman with podman-compose (rootless). |
| 6 | Specific scripts to use / not use? | Allowed: standard authenticated DAST scans and manual testing.<br>Not allowed: denial-of-service, load or stress testing, and high-volume brute force. Login is rate-limited (6 per minute per IP) and accounts lock after 5 failed attempts for 15 minutes, so automated login fuzzing will lock the test accounts.<br>Please exclude these endpoints from automated crawling and replay (test them manually): run start/retry, digest resend, email send/test, and "sign out everywhere". They trigger paid LLM calls, outbound email, or revoke the scanner's own session. |
| 7 | Functionality to include / exclude | Include: all modules listed above, the REST API under /api/v1/, and the gateway (headers, methods, rate limits).<br>Exclude: /phpmyadmin/ (admin tool, not in production) and every third-party API (Perplexity, Gemini, Microsoft Graph, WhatsApp). |
| 8 | Focused areas needing special attention | Authentication and session management (lockout, session expiry, password policy, forced password change).<br>Authorisation / IDOR between Admin and Member and between module permission levels.<br>CSRF.<br>File upload (Excel/CSV parsing, size limits, malicious content).<br>Stored XSS and template injection through email templates and uploaded data.<br>Prompt injection: uploaded company names feed the LLM research prompt.<br>Secrets handling for provider API keys. |
| 9 | Other 3rd-party software / plugins | Perplexity API (LLM research), Google Gemini API (alternative LLM), Microsoft Graph Mail.Send through an Entra ID (Azure AD) app registration (email delivery), WhatsApp delivery adapter, phpMyAdmin 5.2.3 (dev/UAT only).<br>Libraries: FastAPI, Pydantic 2, SQLAlchemy 2, Celery 5, httpx, openpyxl, cryptography, argon2-cffi; React 19, TanStack Query 5, Tailwind CSS, shadcn/ui. |
| 10 | Identity Access Management control in place? | Yes, built into the application: local user accounts with role-based (Admin/Member) and per-module (view/manage) permissions, enforced on the server for every API request (fail-closed). It is not yet integrated with an enterprise IAM / SSO. |

## Hosting Details

| S. No. | Item | Customer response |
|---|---|---|
| 1 | Application hosting details * | Intranet. Hosted on an internal Linux server in rootless Podman containers. Only the nginx gateway publishes a port; MySQL and Redis are on an internal network with no internet access. Outbound internet access is used only to call the LLM and Microsoft Graph APIs. |
| 2 | Business constraints on availability * | [TO FILL: availability window and time zone, e.g. Mon to Fri, 10:00 to 19:00 IST] |
| 3 | Testing Window * | [TO FILL: testing start and end dates] |
| 4 | Dedicated mail server? | No dedicated mail server. The application sends digest emails through Microsoft Graph (Microsoft 365) as an app-to-app (OAuth client-credentials) integration. In UAT, delivery uses a console adapter by default, so no real email or WhatsApp messages are sent unless a mailbox is connected in Providers & channels. |
| 5 | Links that run computationally expensive DB queries? | Yes:<br>Audit log "verify" (/api/v1/audit/verify) walks the whole hash chain.<br>Cost-ledger and dataset exports/downloads.<br>Starting a research run queues one LLM call per logo, at a real cost (UAT budget cap: USD 100 per month).<br>Please do not run these repeatedly from automated scans. |
| 6 | Complex / run-time logging? | Yes. Tamper-evident, hash-chained audit log in the database (sign-ins, failures, lockouts, admin actions with field-level diffs, request ID, client IP, user agent); pipeline telemetry events; structured application logs and nginx access logs on container stdout. |
| 7 | Previous security assessments? | [TO FILL: Yes/No; if yes, attach the report or summarise findings and status]<br>A description of the security controls and how to check each one is available in docs/security.md and can be shared. |

## API Details

| S. No. | Item | Customer response |
|---|---|---|
| 1 | Type of request | [TO FILL: Adhoc / Confirmatory] |
| 2 | BRD / Architecture / Data-flow diagram | Attached: the architecture and data-flow diagrams from README.md and docs/security.md (high-level architecture, research flow, deployment and network layout). |
| 3 | No. of APIs for the web application | 118 REST endpoints under /api/v1 (60 GET, 42 POST, 6 PUT, 5 PATCH, 5 DELETE). |
| 4 | No. of APIs to be tested | All 118, except where listed under Scope of Testing APIs. |
| 5 | API UAT URLs | [TO FILL: UAT URL]/api/v1/ (same origin as the web application, through the nginx gateway) |
| 6 | API Production URLs | [TO FILL: production URL, or "Not yet live"] |
| 7 | Request / Response details | REST over HTTP(S), JSON request and response bodies (multipart/form-data for file uploads). An OpenAPI 3 (Swagger) specification will be provided as a file. The interactive /docs and /openapi.json endpoints are disabled in UAT and production on purpose. |
| 8 | External / internal APIs | Internal. The APIs are consumed only by the application's own SPA (same origin, CORS disabled) and are not published to external consumers. The application itself calls external third-party APIs (Perplexity, Google Gemini, Microsoft Graph), which are out of scope. |
| 9 | Any API hosted on the cloud? | No. The application APIs are self-hosted on the internal server. The third-party LLM and Microsoft Graph APIs it calls are cloud services. |
| 10 | Scope of Testing APIs | In scope: all /api/v1/* endpoints.<br>Exclusions / manual only: run start/retry, digest resend and email send/test (paid LLM calls or outbound messages), and session-revoking endpoints. |
| 11 | Test Data | Authentication: POST /api/v1/auth/login with username and password returns the ttbs_session cookie and a CSRF token. Send the cookie on every request, and send the token in the X-CSRF-Token header on POST/PUT/PATCH/DELETE. Credentials are shared separately. |
| 12 | API document with mandatory / unique parameters | The OpenAPI specification (above) lists every endpoint with its parameters, required fields and validation rules. Request bodies reject unknown fields. |

