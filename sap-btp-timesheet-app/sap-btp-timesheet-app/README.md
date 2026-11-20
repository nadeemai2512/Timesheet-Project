# Unified SAPUI5 & SAP CAP Timesheet & Leave Portal (SAP BTP)

Complete full-stack enterprise application built on **SAP Cloud Application Programming Model (CAP - Node.js)**, **SAP HANA Cloud / SQLite**, **XSUAA**, **SAP Build Process Automation**, and **SAPUI5 (SAP Horizon Theme)**.

---

## Architecture & Module Structure

```text
sap-btp-timesheet-app/
├── package.json                  # CAP backend dependencies, XSUAA & S/4HANA destination config
├── xs-security.json              # XSUAA roles (Employee, ProjectManager, HRAdmin) & EmployeeID attribute
├── mta.yaml                      # Multi-Target Application descriptor for SAP BTP Cloud Foundry
├── db/
│   ├── schema.cds                # HANA/SQLite Data Model (Employees, Projects, Leaves, Holidays, Timesheets, AuditLogs)
│   └── data/                     # Realistic pre-seeded CSV master & transactional data (Hyderabad / India calendar)
├── srv/
│   ├── timesheet-service.cds     # OData V4 Service definition, actions, functions & analytics endpoints
│   └── timesheet-service.js      # Automated CAP validations, leave locking, Copy Week, BPA & S/4HANA CATS posting
└── app/timesheet/
    ├── package.json              # SAPUI5 frontend build & dev scripts
    ├── ui5.yaml                  # UI5 tooling & OData proxy configuration
    ├── xs-app.json               # SAP Build Work Zone / AppRouter routing & XSUAA enforcement
    └── webapp/
        ├── manifest.json         # SAPUI5 OData V4 manifest
        ├── Component.js          # Device & ViewModel initialization
        ├── view/Main.view.xml    # 4-Tab Fiori Horizon UI (Weekly Grid, Leaves, Manager Approvals, VizFrame Analytics)
        └── controller/Main.controller.js # Full frontend-to-backend OData V4 CRUD & workflow logic
```

---

## Quick Start (Local Development — Runs Out of the Box)

### Prerequisites
- **Node.js** v18 or v20+
- **SAP CDS Development Kit** (`npm install -g @sap/cds-dk`)

### Step 1: Install Dependencies & Start Backend + Frontend
```bash
cd sap-btp-timesheet-app
npm install
cds watch
```
1. CAP will automatically create the local SQLite database (`db/timesheet.db`), load all CSV seed data, and serve the OData V4 API at `http://localhost:4004/odata/v4/timesheet/`.
2. Open your browser to **`http://localhost:4004/timesheet/webapp/index.html`**.

---

## End-to-End Walkthrough (From Work to Leave & S/4HANA CATS)

1. **Weekly Timesheet Grid (`1. Weekly Timesheet (Work)` tab):**
   - View **Ravi Kumar Sharma (`EMP1001`)** for week **16 Nov – 22 Nov 2026**.
   - **Mon–Thu** have pre-populated project entries across **S/4HANA Greenfield Rollout** (Billable) and **Internal Bench/CoE** (Non-Billable), tagged with `IN_OFFICE` and `WFH`.
   - **Friday (20 Nov 2026)** is **automatically locked and highlighted** because Ravi has an **Approved Privilege Leave (`SF-LV-88412`)** synced from SAP SuccessFactors.
   - Try logging `> 8 hours` on a day without remarks — CAP blocks it with an overtime remark rule.
   - Click **Submit for Approval** — CAP verifies all non-leave/non-holiday weekdays have `>= 8h` and triggers an SAP Build Process Automation instance (`BPA-WF-xxxxx`).
2. **Leaves & Holiday Calendar (`2. Leaves & Holiday Calendar` tab):**
   - View remaining Leave Balances (`PL: 14.5d`, `CL: 4.0d`, `SL: 8.0d`), approved SuccessFactors leaves, and the **India / Hyderabad (`IN-TG`)** holiday calendar.
   - Click **Apply Leave** for any upcoming date (e.g., `2026-11-23`), navigate to the next week in Tab 1, and see that date immediately locked from project time entry.
3. **Manager Approvals & S/4HANA CATS (`3. Manager Approvals & CATS` tab):**
   - Switch the top-right persona dropdown to **Project Manager (Ananya)** or **HR / Payroll Admin (Vikram)**.
   - Select one or more `SUBMITTED` timesheets and click **Bulk Approve & Post to S/4HANA CATS** to generate a `CATS-2026-xxxxxx` posting document and update project budget burn.
4. **Analytics & Compliance (`4. Analytics & Audit` tab):**
   - View the **SAPUI5 VizFrame Donut Chart** (Billable vs. Non-Billable vs. Overtime), **3-Day In-Office Hybrid Compliance**, **Defaulter List**, and the immutable **SAP HANA Cloud Audit Log**.

---

## Deploying to SAP BTP (Cloud Foundry)
1. Configure BTP Destinations in BTP Cockpit:
   - `S4HANA_CLOUD_CONNECTOR` (via Cloud Connector for `API_ENTERPRISE_PROJECT_SRV` and `API_MANAGE_WORKFORCE_TIMESHEET`)
   - `SUCCESSFACTORS_API` (for employee leave balances & approved leaves)
   - `SAP_BUILD_PROCESS_AUTOMATION` (for approval workflow & 48-hour escalation)
2. Build and deploy the MTA archive:
```bash
mbt build
cf deploy mta_archives/sap-btp-timesheet-app_1.0.0.mtar
```
