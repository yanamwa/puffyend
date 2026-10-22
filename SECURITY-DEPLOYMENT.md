# Deployment configuration

Set NODE_ENV=production and configure the keys in .env.example privately in Hostinger. Production startup rejects missing database credentials, a missing HTTPS FRONTEND_URL, or a JWT_SECRET shorter than 32 characters. Generate a random secret with `node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"`. Changing JWT_SECRET signs out existing sessions.

Only FRONTEND_URL's origin is allowed by production CORS. Set it to https://puffybrain.fun, or use a different canonical frontend origin deliberately. Development additionally permits local frontend ports. CORS does not authenticate non-browser clients.

TRUST_PROXY_HOPS defaults to 0. Verify Hostinger's actual reverse proxy topology and configure the trusted hop count before launch. Do not trust arbitrary forwarded headers. Login permits 10 attempts per IP per 15 minutes; aliases share the same limiter. Signup and recovery each have separate budgets. The default limiter store is per process; multiple backend instances require a shared store.

Public static uploads are restricted to profile-images. Verification images require an admin or Super Admin bearer token through /api/uploads/professor-ids/:filename. Frontend image previews must fetch with Authorization and display a blob URL; unauthenticated image links will now fail. Lesson source files retain their existing authorized download endpoint. Other /uploads and /api/uploads paths return 404.

Profile and onboarding endpoints, including PHP aliases, now require a bearer token and the signed-in account's email. Course/module reads and legacy progress calls now require a token. Send Authorization from every corresponding frontend call. Progress and feedback user IDs come from the authenticated identity.

No default administrator password is created. If provisioning the first Super Admin, supply SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD, then remove the password after provisioning. Rotate any existing administrator using the former built-in password. The existing explicit bootstrap password behavior resets that account on startup while the variable remains set.

Run `npm run test:security`. The pre-existing npm test command references missing test files. Selected existing calendar and catalog tests can run with `node --test tests/academicCalendar.test.js tests/courseCatalog.test.js`.

Compatible dependency updates were applied. The final audit still reports vulnerabilities; review npm audit before production. Do not use audit fix --force blindly because suggested resolutions include obsolete major versions. node_modules was already tracked by this repository, so dependency installation also changes tracked vendored files.

This review does not establish complete application security. Complete authenticated end-to-end ownership tests against a disposable MySQL database, review remaining controllers and upload content validation, verify mail/AI services, configure HTTPS for api.puffybrain.fun, and verify database network restrictions in the hosting provider. The backend was not started against the existing database and no hosting deployment was performed.
