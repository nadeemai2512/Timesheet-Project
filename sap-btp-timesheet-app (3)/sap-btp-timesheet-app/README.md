# Unified SAPUI5 & SAP CAP Timesheet & Leave Portal (SAP BTP)

Complete full-stack enterprise application built on **SAP Cloud Application Programming Model (CAP — Node.js)**, **SAP HANA Cloud / SQLite**, **XSUAA**, **SAP Build Process Automation**, **SAP S/4HANA CATS**, **SAP SuccessFactors** and **SAPUI5 (SAP Horizon Theme)**.

> **Status: fully working.** All OData V4 endpoints, CRUD operations, bound actions, the weekly grid, manager approvals, analytics and audit trail have been verified end-to-end against the deployed SQLite database (see _Verification_ below).

---

## What was broken and what was fixed

The original project's CDS model did not compile, so the CAP service never started and the SAPUI5 frontend had no data to display. The root causes and their fixes are summarised below.

### Backend (CAP)

| # | Root cause | Fix |
|---|---|---|
| 1 | **CDS compilation failure** — `srv/timesheet-service.cds` declared `function getWeeklyGrid(...) returns { header: TimesheetHeaders; assignments: array of ProjectAssignments; … }`. The CDS compiler rejects entity-typed elements inside an inline anonymous structured return type (`"A type or an element is expected here"`), which blocked the **entire service** from compiling → no OData endpoints → no data in the UI. | Changed the return type to `returns String`; the implementation now returns `JSON.stringify({ header, assignments, holidays, approvedLeaves, leaveBalance, compliance })`. The frontend parses `response.value`. |
| 2 | **PATCH validation bypass** — `before UPDATE TimesheetEntries` read `data.ID`, but an OData V4 PATCH body only contains the patched fields (no `ID`, `header_ID`, `project_ID`, `workDate`), so every validation silently no‑oped on edits. | The handler now resolves the existing row from the URL key (`req.params[0].ID`) for PATCH and fetches the missing foreign keys, so validations and header recalculation run on every edit. |
| 3 | **DELETE had no recalculation hook** — `after DELETE` received no `header_ID`, so weekly totals drifted after an entry was removed. | Added a `before DELETE` handler that stashes the deleted entry's `header_ID` on `req`; the `after` hook now recalculates the parent header for CREATE, UPDATE **and** DELETE. |

### Frontend (SAPUI5)

| # | Root cause | Fix |
|---|---|---|
| 4 | **No employee selection dropdown** — the profile header was hardcoded to `Ravi Kumar Sharma (EMP1001)`; there was no way to switch employees. | Added a `Select` bound to the OData V4 `{/Employees}` entity set. Selecting an employee reloads that employee's profile, leave records and weekly grid. |
| 5 | **Hardcoded profile section** — name, role, location and reporting manager were static strings. | The profile now binds dynamically to `vm>/selectedEmployee` (fetched from `Employees('ID')?$expand=manager($select=fullName)`); avatar initials are computed via a `formatInitials` formatter. |
| 6 | **`getWeeklyGrid` response shape changed** — once the return type became `String`, the payload arrives as `{ "value": "<json>" }`. The old controller read `oData.header` directly (always `undefined`). | Added `_unwrapGridResult` which `JSON.parse`s `value` before populating the view model. |
| 7 | **`manifest.json` referenced a non-existent `localService/metadata.xml`** and carried OData v2‑only settings (`synchronizationMode`, `operationMode`). | Removed `localUri`; cleaned the model `settings` to valid OData V4 options (`autoExpandSelect`, `earlyRequests`). |
| 8 | **List tables used `fetch()` into a JSONModel only** — the user asked for proper OData V4 model binding. | The employee dropdown, **TimesheetHeaders approval queue** (with `$expand=employee`), **PublicHolidays** and **AuditLogs** tables are now bound directly to the default OData V4 model in `Main.view.xml`. The weekly matrix and analytics (custom‑function payloads) remain on the JSONModel `vm`, which is the correct SAPUI5 pattern for computed data. |
| 9 | **No DELETE operation & no explicit Refresh** — editing a cell to `0` patched the entry to zero hours instead of removing it. | `onSaveDraft` now sends `DELETE TimesheetEntries(id)` when an existing entry's hours are cleared to `0` (full CRUD: POST/PATCH/DELETE). A **Refresh** button was added to the tool header. |
| 10 | **OData bindings were not refreshed after mutations** — approvals/audit stayed stale after submit/approve/reject. | Added `_refreshODataBindings()` which calls `getBinding("items").refresh()` on the approval and audit tables after every create/update/delete/submit/approve/reject/apply‑leave. |

### Verified action / function URL format (OData V4, CAP)

All frontend calls were confirmed against the running server:

- **Functions** use parentheses: `getWeeklyGrid(employeeId='EMP1001',weekStartDate=2026-11-16)`, `getManagerAnalytics()`.
- **Bound actions** do **not** use parentheses and use the service namespace: `POST /TimesheetHeaders(ID)/TimesheetService.submitTimesheet` (also `rejectTimesheet`, `unlockTimesheet`, `approveTimesheet`).
- **Unbound actions** do **not** use parentheses: `POST /TimesheetService.copyPreviousWeek`, `POST /TimesheetService.bulkApproveTimesheets`, `POST /TimesheetService.applyLeave`.

---

## Architecture & Module Structure

```text
sap-btp-timesheet-app/
├── package.json                  # CAP backend dependencies, SQLite/HANA & XSUAA config, mocked dev users
├── xs-security.json              # XSUAA roles (Employee, ProjectManager, HRAdmin) & EmployeeID attribute
├── mta.yaml                      # Multi-Target Application descriptor for SAP BTP Cloud Foundry
├── README.md
├── db/
│   ├── schema.cds                # Data model (Employees, Projects, Assignments, Holidays, Leaves, Timesheets, AuditLogs)
│   └── data/                     # Pre-seeded CSV master & transactional data (Hyderabad / India calendar)
├── srv/
│   ├── timesheet-service.cds     # OData V4 service, bound actions, functions & analytics endpoints
│   └── timesheet-service.js      # CAP validations, leave locking, Copy-Week, BPA & S/4HANA CATS posting
└── app/timesheet/
    ├── package.json              # SAPUI5 frontend build & dev scripts
    ├── ui5.yaml                  # UI5 tooling + fiori-tools-proxy (for the optional two-server mode)
    ├── ui5-deploy.yaml           # UI5 build for HTML5 Application Repository deploy
    ├── xs-app.json               # AppRouter routing & XSUAA enforcement (BTP)
    └── webapp/
        ├── manifest.json         # SAPUI5 OData V4 manifest + routing
        ├── Component.js          # Device model + JSONModel view-state init
        ├── index.html            # Bootstrap (UI5 1.120, SAP Horizon)
        ├── i18n/i18n.properties
        ├── css/style.css         # Fiori Horizon styling
        ├── view/App.view.xml     # Shell + App container
        ├── view/Main.view.xml    # 4-tab Fiori UI (Weekly Grid, Leaves, Approvals, Analytics+Audit)
        └── controller/
            ├── App.controller.js
            └── Main.controller.js  # Full frontend-to-backend OData V4 CRUD & workflow logic
```

---

## Quick Start (Local Development — runs out of the box)

### Prerequisites
- **Node.js** v18, v20 or v22
- **SAP CDS Development Kit**: `npm install -g @sap/cds-dk` (the project's own `@sap/cds` dependency also works locally via `npx cds`)

### Option A — single command (recommended)

`cds watch` serves **both** the OData V4 backend **and** the SAPUI5 frontend on the same origin (`http://localhost:4004`), so no proxy is needed.

```bash
cd sap-btp-timesheet-app
npm install
npx cds deploy --profile development --to sqlite:db/timesheet.db   # create DB + load CSV seeds (first run)
npx cds watch --profile development
```

Open the app in your browser:

**`http://localhost:4004/timesheet/webapp/index.html`**

The OData V4 service is at `http://localhost:4004/odata/v4/timesheet/`.

### Option B — two servers (UI5 tooling with live reload)

Use this if you want the SAPUI5 tooling dev server (`ui5 serve`) with hot reload.

Terminal 1 (backend):
```bash
cd sap-btp-timesheet-app
npm install
npx cds deploy --profile development --to sqlite:db/timesheet.db
npx cds watch --profile development
```

Terminal 2 (frontend — proxies `/odata` to `http://localhost:4004` via `ui5.yaml`):
```bash
cd sap-btp-timesheet-app/app/timesheet
npm install
npm start          # ui5 serve -o index.html  →  http://localhost:8080
```

### Resetting the database

To reload the seed data (e.g. after experimenting with submit/approve/delete):

```bash
rm db/timesheet.db
npx cds deploy --profile development --to sqlite:db/timesheet.db
```

---

## Data Model

| Entity | Key | Purpose |
|---|---|---|
| `Employees` | `String(10)` (e.g. `EMP1001`) | Employee master + self-referencing `manager` |
| `Projects` | `String(20)` (e.g. `PRJ-S4-001`) | WBS projects, billable flag, PO expiry, budget/consumed hours |
| `ProjectAssignments` | UUID (cuid) | Employee ↔ project allocation window + allocated hours |
| `PublicHolidays` | UUID | India / Hyderabad (`IN-TG`) holiday calendar (mandatory + optional) |
| `EmployeeLeaves` | UUID (cuid) | Leave requests with SuccessFactors ref + approval status |
| `LeaveBalances` | UUID | Annual PL/CL/SL balances per employee |
| `TimesheetHeaders` | UUID (cuid) | Weekly header: totals, billable/non-billable/overtime, status, CATS doc, BPA workflow id |
| `TimesheetEntries` | UUID (cuid) | Daily line: project, hours, work mode, task category, remarks |
| `AuditLogs` | UUID (cuid) | Immutable audit trail (CREATE/UPDATE/SUBMIT/APPROVE/REJECT/UNLOCK/CATS_POST) |

### Seed data (Hyderabad, India — week of 16–22 Nov 2026)
- **5 employees**: Ravi Sharma (EMP1001), Priya Nair (EMP1002), Karthik Reddy (EMP1003), Ananya Deshmukh (EMP2001, manager), Vikram Rao (EMP3001, HR).
- **4 projects** (3 ACTIVE billable/non-billable + 1 CLOSED legacy).
- **3 weekly timesheets**: EMP1001 week 09–15 Nov `POSTED_CATS` (CATS-2026-009412), EMP1001 week 16–22 Nov `DRAFT`, EMP1002 week 16–22 Nov `SUBMITTED`.
- **1 approved leave**: Ravi — Privilege Leave on Fri 20 Nov (`SF-LV-88412`), which auto-locks that day in the grid.

---

## OData V4 Endpoint Reference (base: `/odata/v4/timesheet/`)

### Entity sets (GET / OData V4 list bindings)
- `GET /Employees` — dropdown + profile
- `GET /Employees('EMP1001')?$expand=manager($select=fullName)` — profile context
- `GET /Projects` — project master
- `GET /ProjectAssignments` — allocations
- `GET /PublicHolidays` — holiday calendar table
- `GET /EmployeeLeaves?$filter=employee_ID eq 'EMP1001'` — leave records table
- `GET /LeaveBalances` — leave balances (also returned inside `getWeeklyGrid`)
- `GET /TimesheetHeaders?$expand=employee($select=fullName,department)` — manager approval queue
- `GET /TimesheetEntries` — daily entries (used internally by the grid)
- `GET /AuditLogs` — audit trail table

### CRUD on `TimesheetEntries`
- `POST /TimesheetEntries` — create a daily entry (body uses `header_ID` / `project_ID` foreign keys)
- `PATCH /TimesheetEntries(ID)` — update hours / work mode / remarks
- `DELETE /TimesheetEntries(ID)` — remove an entry (triggered when hours cleared to 0)

### Custom functions
- `GET /getWeeklyGrid(employeeId='EMP1001',weekStartDate=2026-11-16)` → `{ "value": "<JSON: header, assignments, holidays, approvedLeaves, leaveBalance, compliance>" }`
- `GET /getEmployeeMonthlySummary(employeeId='EMP1001',year=2026,month=11)`
- `GET /getManagerAnalytics()`

### Bound actions (on `TimesheetHeaders`)
- `POST /TimesheetHeaders(ID)/TimesheetService.submitTimesheet`
- `POST /TimesheetHeaders(ID)/TimesheetService.approveTimesheet`  (body: `{comments}`)
- `POST /TimesheetHeaders(ID)/TimesheetService.rejectTimesheet`   (body: `{rejectionReason}`)
- `POST /TimesheetHeaders(ID)/TimesheetService.unlockTimesheet`   (body: `{hrRemarks}`)
- `POST /TimesheetHeaders(ID)/TimesheetService.postToCATS`

### Unbound actions
- `POST /TimesheetService.copyPreviousWeek`        (body: `{employeeId, targetWeekStartDate}`)
- `POST /TimesheetService.bulkApproveTimesheets`   (body: `{headerIds:[…], comments}`) → returns Integer
- `POST /TimesheetService.applyLeave`              (body: `{employeeId, leaveType, startDate, endDate, reason}`)

---

## Business Rules Implemented (srv/timesheet-service.js)

1. **15-day auto-lock** — entries older than 15 days lock automatically; APPROVED/POSTED_CATS timesheets are immutable.
2. **Weekend block** — Sat/Sun logging rejected without HR override.
3. **Public-holiday lock** — no project hours on mandatory India/Hyderabad holidays.
4. **Approved-leave lock** — dates covered by an approved SuccessFactors leave are locked.
5. **Project validation** — CLOSED projects, expired POs, exhausted budgets and out-of-window assignments are rejected.
6. **Daily cap & overtime remarks** — max 12 h/day; >8 h/day requires remarks ≥ 5 chars.
7. **Submit gate** — Mon–Fri must each total ≥ 8 h (unless covered by leave/holiday) before submission routes to BPA.
8. **Approve → CATS post** — approval auto-posts to S/4HANA CATS, increments project consumed hours and locks the timesheet.
9. **Header recalculation** — total/billable/non-billable/overtime/office-days are recomputed on every CREATE, UPDATE and DELETE of an entry.

---

## End-to-End Walkthrough

1. **Tab 1 — Weekly Timesheet (Work):** Pick an employee from the dropdown. The grid loads that employee's assigned active projects and existing entries for the week (16–22 Nov 2026 for EMP1001). Mon–Thu are pre-populated; **Friday 20 Nov is locked & highlighted** because of the approved Privilege Leave. Edit a cell, set another to `0` (DELETE), then **Save Draft** (POST/PATCH/DELETE + recalculation). **Submit for Approval** runs the 8 h/day compliance check and routes to BPA. Use **Copy Previous Week** to clone the prior week's allocations.
2. **Tab 2 — Leaves & Holiday Calendar:** view leave balances, SuccessFactors leave records and the IN-TG holiday calendar. **Apply Leave** for a future date, then jump to that week in Tab 1 to see the date auto-locked.
3. **Tab 3 — Manager Approvals & CATS:** switch the persona to **Project Manager**. Select `SUBMITTED` rows and **Bulk Approve & Post to S/4HANA CATS** — a `CATS-2026-xxxxxx` document is generated, project burn is updated and the timesheet is locked. **Reject Selected** with a mandatory reason; **HR Unlock Period** (HR persona) reopens a locked period.
4. **Tab 4 — Analytics & Audit:** VizFrame donut (Billable vs Non-Billable vs Overtime), 3-day in-office hybrid compliance, defaulter list and the immutable audit trail.

---

## Verification (performed before delivery)

- `cds compile db/schema.cds -2 sql` → clean (no errors)
- `cds compile srv/timesheet-service.cds -2 sql` → clean (no errors)
- `cds deploy --profile development --to sqlite:db/timesheet.db` → 8 CSV files loaded successfully
- `node --check` on `Component.js`, `App.controller.js`, `Main.controller.js` → all OK
- `manifest.json` → valid JSON
- `view/App.view.xml`, `view/Main.view.xml` → well-formed XML
- All 8 frontend-bound OData endpoints (`/Employees`, `/Employees('…')?$expand=manager`, `getWeeklyGrid`, `EmployeeLeaves?$filter`, `/PublicHolidays`, `/TimesheetHeaders?$expand=employee`, `/AuditLogs`, `getManagerAnalytics`) → **HTTP 200 with real data**
- `getWeeklyGrid` parsed via `.value` → header `DRAFT` / 34 h / 5 entries / 3 assignments / 6 holidays / 1 leave / PL balance 14.5
- CRUD cycle confirmed: POST entry → PATCH (6.5 h) → DELETE → header totals recalculated (32 h → 24 h, office days 2 → 1)
- Bound action `submitTimesheet` (DRAFT → SUBMITTED + `workflowInstanceId`) and `rejectTimesheet` (SUBMITTED → REJECTED) confirmed working

---

## SAPUI5 / OData V4 Data Binding Summary

| UI control | Model | Binding path |
|---|---|---|
| Employee dropdown | OData V4 (default) | `{path:'/Employees', parameters:{$orderby:'fullName asc'}}` |
| Profile header (name, role, location, manager) | JSONModel `vm` | `vm>/selectedEmployee/…` (loaded from `Employees('ID')?$expand=manager`) |
| KPI cards, weekly matrix, day strip | JSONModel `vm` | `vm>/header/…`, `vm>/gridRows`, `vm>/daysMeta` (from `getWeeklyGrid`) |
| Leaves table | JSONModel `vm` | `vm>/allEmployeeLeaves` (filtered fetch) |
| Public Holidays table | OData V4 (default) | `{path:'/PublicHolidays', parameters:{$orderby:'holidayDate asc'}}` |
| Manager approval queue | OData V4 (default) | `{path:'/TimesheetHeaders', parameters:{$expand:'employee($select=fullName,department)'}}` |
| Audit trail table | OData V4 (default) | `{path:'/AuditLogs', parameters:{$orderby:'performedAt desc'}}` |
| Analytics donut + compliance tables | JSONModel `vm` | `vm>/managerAnalytics/…` (from `getManagerAnalytics`) |

This split is intentional: **entity-backed lists use the OData V4 model** (server-driven paging, `$expand`, `$filter`, automatic refresh), while **computed / custom-function payloads use the JSONModel** — the standard SAPUI5 pattern.

---

## Deploying to SAP BTP (Cloud Foundry)

1. Configure BTP destinations in the BTP Cockpit:
   - `S4HANA_CLOUD_CONNECTOR` — via Cloud Connector, for `API_ENTERPRISE_PROJECT_SRV` and `API_MANAGE_WORKFORCE_TIMESHEET`
   - `SUCCESSFACTORS_API` — for employee leave balances & approved leaves
   - `SAP_BUILD_PROCESS_AUTOMATION` — for the approval workflow & 48-hour escalation
2. Build and deploy the MTA archive:
```bash
mbt build
cf deploy mta_archives/sap-btp-timesheet-app_1.0.0.mtar
```
3. Assign the XSUAA role collections (`Employee`, `ProjectManager`, `HRAdmin`) to users in the BTP cockpit.

---

## Notes & Assumptions

- The `getEmployeeMonthlySummary` and `postToCATS` endpoints are implemented and exposed but not yet wired into a UI control; they are available for future dashboard tiles.
- In production, the CATS posting, BPA workflow trigger and SuccessFactors sync are REST calls to the configured BTP destinations; in local development they are simulated (deterministic document/instance IDs are generated and audited).
- Mocked development users (in `package.json` → `cds.requires.[development].auth`): `emp.ravi@company.com` / `pass` (Employee), `mgr.ananya@company.com` / `pass` (ProjectManager), `hr.vikram@company.com` / `pass` (HRAdmin). Anonymous reads also work locally because the entities have no `@requires` annotation.
