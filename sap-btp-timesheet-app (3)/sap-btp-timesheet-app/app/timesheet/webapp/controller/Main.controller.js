sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/m/MessageBox",
  "sap/m/MessageToast",
  "sap/m/Dialog",
  "sap/m/Button",
  "sap/m/Label",
  "sap/m/Select",
  "sap/m/DatePicker",
  "sap/m/TextArea",
  "sap/m/VBox",
  "sap/ui/core/Item",
  "sap/ui/model/Filter",
  "sap/ui/model/FilterOperator"
], function (
  Controller,
  MessageBox,
  MessageToast,
  Dialog,
  Button,
  Label,
  Select,
  DatePicker,
  TextArea,
  VBox,
  Item,
  Filter,
  FilterOperator
) {
  "use strict";

  // Matches the dataSource URI in manifest.json and the CAP service path
  // (srv/timesheet-service.cds: service TimesheetService @(path: '/odata/v4/timesheet')).
  const SERVICE_BASE = "/odata/v4/timesheet/";

  return Controller.extend("com.company.timesheet.controller.Main", {

    onInit: function () {
      // Initial week label before the first grid load resolves it
      const oVm = this.getView().getModel("vm");
      const sWeekStart = oVm.getProperty("/weekStartDate");
      oVm.setProperty("/weekLabel", this._formatWeekLabel(sWeekStart));

      // Bind entity-backed tables (Employees dropdown, TimesheetHeaders approvals,
      // PublicHolidays, AuditLogs) are declared directly in Main.view.xml against
      // the default OData V4 model and load automatically. The controller only
      // loads the employee-scoped / custom-function payloads below.
      this._loadSelectedEmployee();
      this._loadLeaves();
      this._loadWeeklyGrid();
      this._loadManagerData();
    },

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------
    _getServiceUrl: function () {
      const oModel = this.getOwnerComponent().getModel();
      if (oModel && typeof oModel.getServiceUrl === "function") {
        return oModel.getServiceUrl();
      }
      return SERVICE_BASE;
    },

    _addDays: function (dateStr, days) {
      const d = new Date(dateStr + "T00:00:00Z");
      d.setUTCDate(d.getUTCDate() + days);
      return d.toISOString().split("T")[0];
    },

    _formatShortDate: function (dateStr) {
      if (!dateStr) return "";
      const d = new Date(dateStr + "T00:00:00Z");
      return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" });
    },

    _formatWeekLabel: function (sWeekStart) {
      const sWeekEnd = this._addDays(sWeekStart, 6);
      return `${this._formatShortDate(sWeekStart)} – ${this._formatShortDate(sWeekEnd)}`;
    },

    // getWeeklyGrid returns Edm.String (see srv/timesheet-service.cds); the payload
    // is JSON-serialized and arrives as { "value": "<json>" }.
    _unwrapGridResult: function (oJson) {
      if (oJson && typeof oJson.value === "string") {
        try { return JSON.parse(oJson.value); } catch (e) { return {}; }
      }
      return oJson || {};
    },

    _setBusy: function (bBusy) {
      this.getView().getModel("vm").setProperty("/busy", bBusy);
    },

    // Refresh the OData V4 list bindings that are declared in the view, so the
    // approvals queue and audit trail reflect backend mutations immediately.
    _refreshODataBindings: function () {
      ["approvalTable", "auditTable"].forEach((sId) => {
        const oCtl = this.byId(sId);
        const oBinding = oCtl && oCtl.getBinding("items");
        if (oBinding && typeof oBinding.refresh === "function") {
          oBinding.refresh();
        }
      });
    },

    // -------------------------------------------------------------------------
    // WEEKLY GRID (custom function: getWeeklyGrid)
    // -------------------------------------------------------------------------
    _loadWeeklyGrid: async function () {
      const oVm = this.getView().getModel("vm");
      const sEmpId = oVm.getProperty("/selectedEmployeeId");
      const sWeekStart = oVm.getProperty("/weekStartDate");

      oVm.setProperty("/weekLabel", this._formatWeekLabel(sWeekStart));
      this._setBusy(true);

      try {
        const sUrl = `${this._getServiceUrl()}getWeeklyGrid(employeeId='${sEmpId}',weekStartDate=${sWeekStart})`;
        const oRes = await fetch(sUrl);
        if (!oRes.ok) throw new Error(await oRes.text());
        const oRaw = await oRes.json();
        const oData = this._unwrapGridResult(oRaw);

        oVm.setProperty("/header", oData.header || {});
        oVm.setProperty("/assignments", oData.assignments || []);
        oVm.setProperty("/holidays", oData.holidays || []);
        oVm.setProperty("/approvedLeaves", oData.approvedLeaves || []);
        oVm.setProperty("/leaveBalance", oData.leaveBalance || {});
        oVm.setProperty("/compliance", oData.compliance || {});

        this._buildMatrixModel(oData);
      } catch (err) {
        MessageBox.error("Failed to load weekly timesheet: " + err.message);
      } finally {
        this._setBusy(false);
      }
    },

    _buildMatrixModel: function (oData) {
      const oVm = this.getView().getModel("vm");
      const sWeekStart = oVm.getProperty("/weekStartDate");
      const aDayNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
      const aHolidays = oData.holidays || [];
      const aLeaves = oData.approvedLeaves || [];
      const aEntries = (oData.header && oData.header.entries) || [];
      const aAssignments = oData.assignments || [];
      const bHeaderEditable =
        !oData.compliance.isAutoLocked &&
        (oData.header.status === "DRAFT" || oData.header.status === "REJECTED");

      // Build 7-day metadata strip (Work vs Leave vs Holiday vs Weekend)
      const aDaysMeta = [];
      for (let i = 0; i < 7; i++) {
        const sDate = this._addDays(sWeekStart, i);
        const bWeekend = i >= 5;
        const oHoliday = aHolidays.find((h) => h.holidayDate === sDate && !h.isOptional);
        const oLeave = aLeaves.find(
          (l) => l.status === "APPROVED" && sDate >= l.startDate && sDate <= l.endDate
        );

        let sType = "Working Day";
        let sState = "Information";
        let sNote = "Standard 8h shift";

        if (bWeekend) {
          sType = "Weekend";
          sState = "None";
          sNote = "Weekly Off (Locked)";
        } else if (oHoliday) {
          sType = "Holiday";
          sState = "Success";
          sNote = oHoliday.name;
        } else if (oLeave) {
          sType = "On Leave";
          sState = "Warning";
          sNote = `${oLeave.leaveType} (${oLeave.sfLeaveId})`;
        }

        aDaysMeta.push({
          date: sDate,
          shortDate: this._formatShortDate(sDate),
          dayName: aDayNames[i],
          isWeekend: bWeekend,
          isHoliday: Boolean(oHoliday),
          isLeave: Boolean(oLeave),
          dayTypeLabel: sType,
          dayState: sState,
          note: sNote
        });
      }
      oVm.setProperty("/daysMeta", aDaysMeta);

      // Group entries by Project ID (ensure all active assigned projects appear as rows)
      const mProjectRows = new Map();

      const fnEmptyDayCells = () =>
        aDaysMeta.map((dm) => ({
          entryId: null,
          workDate: dm.date,
          dayOfWeek: dm.dayName,
          hours: 0,
          workMode: "IN_OFFICE",
          isLeave: dm.isLeave,
          isHoliday: dm.isHoliday,
          editable: bHeaderEditable && !dm.isWeekend && !dm.isHoliday && !dm.isLeave
        }));

      aAssignments.forEach((asgn) => {
        if (asgn.project && asgn.project.status === "ACTIVE") {
          mProjectRows.set(asgn.project.ID, {
            projectId: asgn.project.ID,
            projectName: asgn.project.name,
            wbsElement: asgn.project.wbsElement,
            isBillable: asgn.project.isBillable,
            taskCategory: "Development",
            remarks: "",
            rowTotal: 0,
            days: fnEmptyDayCells()
          });
        }
      });

      aEntries.forEach((entry) => {
        const sProjId = entry.project_ID || (entry.project && entry.project.ID);
        if (!mProjectRows.has(sProjId) && entry.project) {
          mProjectRows.set(sProjId, {
            projectId: sProjId,
            projectName: entry.project.name,
            wbsElement: entry.project.wbsElement,
            isBillable: entry.project.isBillable,
            taskCategory: entry.taskCategory || "Development",
            remarks: entry.remarks || "",
            rowTotal: 0,
            days: fnEmptyDayCells()
          });
        }

        const oRow = mProjectRows.get(sProjId);
        if (oRow) {
          if (entry.taskCategory) oRow.taskCategory = entry.taskCategory;
          if (entry.remarks) oRow.remarks = entry.remarks;
          const oDayCell = oRow.days.find((d) => d.workDate === entry.workDate);
          if (oDayCell) {
            oDayCell.entryId = entry.ID;
            oDayCell.hours = Number(entry.hours || 0);
            oDayCell.workMode = entry.workMode || "IN_OFFICE";
          }
        }
      });

      const aRows = Array.from(mProjectRows.values());
      aRows.forEach((r) => {
        r.rowTotal = r.days.reduce((sum, d) => sum + Number(d.hours || 0), 0);
      });

      oVm.setProperty("/gridRows", aRows);
    },

    onCellChanged: function () {
      const oVm = this.getView().getModel("vm");
      const aRows = oVm.getProperty("/gridRows");
      let fTotal = 0, fBillable = 0, fNonBillable = 0;
      const oOfficeSet = new Set();

      aRows.forEach((r) => {
        let fRowSum = 0;
        r.days.forEach((d) => {
          const h = Number(d.hours || 0);
          fRowSum += h;
          if (h > 0 && (d.workMode === "IN_OFFICE" || d.workMode === "CLIENT_SITE")) {
            oOfficeSet.add(d.workDate);
          }
        });
        r.rowTotal = fRowSum;
        fTotal += fRowSum;
        if (r.isBillable) fBillable += fRowSum;
        else fNonBillable += fRowSum;
      });

      oVm.setProperty("/gridRows", aRows);
      oVm.setProperty("/header/totalHours", fTotal);
      oVm.setProperty("/header/billableHours", fBillable);
      oVm.setProperty("/header/nonBillableHours", fNonBillable);
      oVm.setProperty("/compliance/officeDaysLogged", oOfficeSet.size);
    },

    // -------------------------------------------------------------------------
    // EMPLOYEE PROFILE & LEAVES (employee-scoped reads)
    // -------------------------------------------------------------------------
    onEmployeeChange: function (oEvent) {
      const sEmpId = oEvent.getParameter("selectedItem").getKey();
      const oVm = this.getView().getModel("vm");
      oVm.setProperty("/selectedEmployeeId", sEmpId);

      this._loadSelectedEmployee();
      this._loadLeaves();
      this._loadWeeklyGrid();
    },

    _loadSelectedEmployee: async function () {
      const oVm = this.getView().getModel("vm");
      const sEmpId = oVm.getProperty("/selectedEmployeeId");
      const sBaseUrl = this._getServiceUrl();
      try {
        const oRes = await fetch(
          `${sBaseUrl}Employees('${sEmpId}')?$expand=manager($select=fullName)`
        );
        if (!oRes.ok) throw new Error(await oRes.text());
        const oEmp = await oRes.json();
        oVm.setProperty("/selectedEmployee", oEmp);
      } catch (err) {
        oVm.setProperty("/selectedEmployee", {});
      }
    },

    _loadLeaves: async function () {
      const oVm = this.getView().getModel("vm");
      const sEmpId = oVm.getProperty("/selectedEmployeeId");
      const sBaseUrl = this._getServiceUrl();
      try {
        const oRes = await fetch(
          `${sBaseUrl}EmployeeLeaves?$filter=employee_ID eq '${sEmpId}'&$orderby=startDate desc`
        );
        if (!oRes.ok) throw new Error(await oRes.text());
        const d = await oRes.json();
        oVm.setProperty("/allEmployeeLeaves", d.value || []);
      } catch (err) {
        oVm.setProperty("/allEmployeeLeaves", []);
      }
    },

    // -------------------------------------------------------------------------
    // SAVE DRAFT (POST / PATCH / DELETE) — full CRUD on TimesheetEntries
    // -------------------------------------------------------------------------
    onSaveDraft: async function () {
      const oVm = this.getView().getModel("vm");
      const sHeaderId = oVm.getProperty("/header/ID");
      if (!sHeaderId) {
        MessageBox.error("No active timesheet header for this week. Refresh and try again.");
        return;
      }
      const aRows = oVm.getProperty("/gridRows");
      const sBaseUrl = this._getServiceUrl();
      this._setBusy(true);

      try {
        for (const row of aRows) {
          for (let i = 0; i < 5; i++) {
            const cell = row.days[i];
            if (!cell.editable) continue;

            const fHours = Number(cell.hours || 0);

            // DELETE: an existing entry whose hours were cleared to 0
            if (cell.entryId && fHours === 0) {
              const oDel = await fetch(`${sBaseUrl}TimesheetEntries(${cell.entryId})`, {
                method: "DELETE"
              });
              if (!oDel.ok && oDel.status !== 204) {
                const errJson = await oDel.json().catch(() => ({}));
                throw new Error(errJson.error?.message || "Delete failed");
              }
              continue;
            }

            // PATCH: update an existing entry
            if (cell.entryId && fHours > 0) {
              const oPatch = await fetch(`${sBaseUrl}TimesheetEntries(${cell.entryId})`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  hours: fHours,
                  workMode: cell.workMode,
                  taskCategory: row.taskCategory,
                  remarks: row.remarks
                })
              });
              if (!oPatch.ok) {
                const errJson = await oPatch.json().catch(() => ({}));
                throw new Error(errJson.error?.message || "Validation failed");
              }
              continue;
            }

            // POST: create a new entry
            if (!cell.entryId && fHours > 0) {
              const oPost = await fetch(`${sBaseUrl}TimesheetEntries`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  header_ID: sHeaderId,
                  project_ID: row.projectId,
                  workDate: cell.workDate,
                  dayOfWeek: cell.dayOfWeek,
                  hours: fHours,
                  workMode: cell.workMode,
                  taskCategory: row.taskCategory,
                  remarks: row.remarks
                })
              });
              if (!oPost.ok) {
                const errJson = await oPost.json().catch(() => ({}));
                throw new Error(errJson.error?.message || "Validation failed");
              }
            }
          }
        }
        MessageToast.show("Timesheet draft saved & validated successfully!");
        await this._loadWeeklyGrid();
        this._refreshODataBindings();
      } catch (err) {
        MessageBox.error(err.message, { title: "SAP CAP Business Rule Validation" });
      } finally {
        this._setBusy(false);
      }
    },

    // -------------------------------------------------------------------------
    // SUBMIT FOR APPROVAL (bound action: TimesheetHeaders(key)/TimesheetService.submitTimesheet)
    // -------------------------------------------------------------------------
    onSubmitTimesheet: async function () {
      await this.onSaveDraft();
      const oVm = this.getView().getModel("vm");
      const sHeaderId = oVm.getProperty("/header/ID");
      if (!sHeaderId) return;
      const sBaseUrl = this._getServiceUrl();

      try {
        const oRes = await fetch(
          `${sBaseUrl}TimesheetHeaders(${sHeaderId})/TimesheetService.submitTimesheet`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({})
          }
        );
        if (!oRes.ok) {
          const errJson = await oRes.json().catch(() => ({}));
          throw new Error(errJson.error?.message || "Submission failed");
        }
        MessageBox.success(
          "Timesheet submitted successfully! Routed to Project Manager via SAP Build Process Automation."
        );
        await this._loadWeeklyGrid();
        this._refreshODataBindings();
      } catch (err) {
        MessageBox.error(err.message, { title: "Submission Blocked by Compliance Rules" });
      }
    },

    // -------------------------------------------------------------------------
    // COPY PREVIOUS WEEK (unbound action: TimesheetService.copyPreviousWeek)
    // -------------------------------------------------------------------------
    onCopyPreviousWeek: async function () {
      const oVm = this.getView().getModel("vm");
      const sEmpId = oVm.getProperty("/selectedEmployeeId");
      const sWeekStart = oVm.getProperty("/weekStartDate");

      try {
        const oRes = await fetch(`${this._getServiceUrl()}TimesheetService.copyPreviousWeek`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            employeeId: sEmpId,
            targetWeekStartDate: sWeekStart
          })
        });
        if (!oRes.ok) {
          const errJson = await oRes.json().catch(() => ({}));
          throw new Error(errJson.error?.message || "Copy failed");
        }
        MessageToast.show("Previous week allocations cloned (skipping leaves & holidays).");
        await this._loadWeeklyGrid();
        this._refreshODataBindings();
      } catch (err) {
        MessageBox.error(err.message);
      }
    },

    onOpenAddRowDialog: function () {
      MessageToast.show("All active assigned projects for your WBS profile are already loaded in the grid.");
    },

    // -------------------------------------------------------------------------
    // REFRESH
    // -------------------------------------------------------------------------
    onRefresh: function () {
      this._loadSelectedEmployee();
      this._loadLeaves();
      this._loadWeeklyGrid();
      this._loadManagerData();
      this._refreshODataBindings();
      MessageToast.show("Refreshed from SAP CAP backend.");
    },

    // -------------------------------------------------------------------------
    // LEAVE APPLICATION (unbound action: TimesheetService.applyLeave)
    // -------------------------------------------------------------------------
    onOpenApplyLeaveDialog: function () {
      const oTypeSelect = new Select({
        width: "100%",
        items: [
          new Item({ key: "Privilege Leave", text: "Privilege Leave (PL)" }),
          new Item({ key: "Casual Leave", text: "Casual Leave (CL)" }),
          new Item({ key: "Sick Leave", text: "Sick Leave (SL)" })
        ]
      });
      const oStartPicker = new DatePicker({ valueFormat: "yyyy-MM-dd", value: "2026-11-23" });
      const oEndPicker = new DatePicker({ valueFormat: "yyyy-MM-dd", value: "2026-11-23" });
      const oReasonArea = new TextArea({ width: "100%", placeholder: "Reason for leave..." });

      const oDialog = new Dialog({
        title: "Apply Leave (Syncs with SAP SuccessFactors & Timesheet)",
        contentWidth: "400px",
        content: new VBox({
          class: "sapUiSmallMargin",
          items: [
            new Label({ text: "Leave Type" }),
            oTypeSelect,
            new Label({ text: "Start Date", class: "sapUiTinyMarginTop" }),
            oStartPicker,
            new Label({ text: "End Date", class: "sapUiTinyMarginTop" }),
            oEndPicker,
            new Label({ text: "Reason", class: "sapUiTinyMarginTop" }),
            oReasonArea
          ]
        }),
        beginButton: new Button({
          text: "Submit Leave",
          type: "Emphasized",
          press: async () => {
            try {
              const sEmpId = this.getView().getModel("vm").getProperty("/selectedEmployeeId");
              const oRes = await fetch(`${this._getServiceUrl()}TimesheetService.applyLeave`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  employeeId: sEmpId,
                  leaveType: oTypeSelect.getSelectedKey(),
                  startDate: oStartPicker.getValue(),
                  endDate: oEndPicker.getValue(),
                  reason: oReasonArea.getValue() || "Personal Leave"
                })
              });
              if (!oRes.ok) {
                const errJson = await oRes.json().catch(() => ({}));
                throw new Error(errJson.error?.message || "Failed to apply leave");
              }
              MessageToast.show("Leave approved & synced! Timesheet dates automatically locked.");
              oDialog.close();
              await this._loadLeaves();
              await this._loadWeeklyGrid();
              this._refreshODataBindings();
            } catch (e) {
              MessageBox.error(e.message);
            }
          }
        }),
        endButton: new Button({
          text: "Cancel",
          press: () => oDialog.close()
        })
      });
      oDialog.open();
    },

    // -------------------------------------------------------------------------
    // MANAGER ANALYTICS (custom function: getManagerAnalytics)
    // -------------------------------------------------------------------------
    _loadManagerData: async function () {
      const oVm = this.getView().getModel("vm");
      const sBaseUrl = this._getServiceUrl();
      try {
        const oAnalyticsRes = await fetch(`${sBaseUrl}getManagerAnalytics()`);
        if (oAnalyticsRes.ok) {
          const d = await oAnalyticsRes.json();
          oVm.setProperty("/managerAnalytics", d);
        }
      } catch (err) {
        // non-fatal: analytics panel simply stays empty
      }
    },

    // -------------------------------------------------------------------------
    // APPROVALS — Bulk Approve / Reject / HR Unlock (bound actions)
    // The approval table is bound to the OData V4 {/TimesheetHeaders} list, so
    // selected contexts come from the default model.
    // -------------------------------------------------------------------------
    onBulkApprove: async function () {
      const oTable = this.byId("approvalTable");
      const aSelected = oTable.getSelectedItems();
      if (!aSelected.length) {
        MessageToast.show("Select one or more submitted timesheets to approve.");
        return;
      }

      const aIds = aSelected.map((item) => item.getBindingContext().getObject().ID);
      try {
        const oRes = await fetch(`${this._getServiceUrl()}TimesheetService.bulkApproveTimesheets`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            headerIds: aIds,
            comments: "Bulk approved by Project Manager"
          })
        });
        if (!oRes.ok) {
          const errJson = await oRes.json().catch(() => ({}));
          throw new Error(errJson.error?.message || "Bulk approval failed");
        }
        MessageBox.success(
          `${aIds.length} timesheet(s) approved and automatically posted to SAP S/4HANA CATS!`
        );
        oTable.removeSelections(true);
        await this._loadWeeklyGrid();
        await this._loadManagerData();
        this._refreshODataBindings();
      } catch (e) {
        MessageBox.error(e.message);
      }
    },

    onOpenRejectDialog: function () {
      const oTable = this.byId("approvalTable");
      const aSelected = oTable.getSelectedItems();
      if (aSelected.length !== 1) {
        MessageToast.show("Select exactly one timesheet to reject with comments.");
        return;
      }
      const sHeaderId = aSelected[0].getBindingContext().getObject().ID;
      const oReasonInput = new TextArea({
        width: "100%",
        placeholder: "Enter mandatory rejection reason (e.g., Incorrect WBS allocation on Wednesday)..."
      });

      const oDialog = new Dialog({
        title: "Reject Timesheet Entry",
        contentWidth: "400px",
        content: new VBox({
          class: "sapUiSmallMargin",
          items: [new Label({ text: "Mandatory Rejection Reason", required: true }), oReasonInput]
        }),
        beginButton: new Button({
          text: "Reject Timesheet",
          type: "Reject",
          press: async () => {
            try {
              const oRes = await fetch(
                `${this._getServiceUrl()}TimesheetHeaders(${sHeaderId})/TimesheetService.rejectTimesheet`,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ rejectionReason: oReasonInput.getValue() })
                }
              );
              if (!oRes.ok) {
                const err = await oRes.json().catch(() => ({}));
                throw new Error(err.error?.message || "Rejection failed");
              }
              MessageToast.show("Timesheet rejected and returned to employee.");
              oDialog.close();
              oTable.removeSelections(true);
              await this._loadWeeklyGrid();
              await this._loadManagerData();
              this._refreshODataBindings();
            } catch (e) {
              MessageBox.error(e.message);
            }
          }
        }),
        endButton: new Button({ text: "Cancel", press: () => oDialog.close() })
      });
      oDialog.open();
    },

    onHrUnlockSelected: async function () {
      const oTable = this.byId("approvalTable");
      const aSelected = oTable.getSelectedItems();
      if (aSelected.length !== 1) {
        MessageToast.show("Select one locked timesheet to unlock.");
        return;
      }
      const sHeaderId = aSelected[0].getBindingContext().getObject().ID;
      try {
        const oRes = await fetch(
          `${this._getServiceUrl()}TimesheetHeaders(${sHeaderId})/TimesheetService.unlockTimesheet`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ hrRemarks: "Unlocked by HR Admin for period adjustment" })
          }
        );
        if (!oRes.ok) {
          const err = await oRes.json().catch(() => ({}));
          throw new Error(err.error?.message || "Unlock failed");
        }
        MessageToast.show("Timesheet unlocked by HR Admin.");
        oTable.removeSelections(true);
        await this._loadWeeklyGrid();
        this._refreshODataBindings();
      } catch (e) {
        MessageBox.error(e.message);
      }
    },

    // -------------------------------------------------------------------------
    // NAVIGATION / WEEK STEPPING / PERSONA
    // -------------------------------------------------------------------------
    onPrevWeek: function () {
      const oVm = this.getView().getModel("vm");
      oVm.setProperty("/weekStartDate", this._addDays(oVm.getProperty("/weekStartDate"), -7));
      this._loadWeeklyGrid();
    },

    onNextWeek: function () {
      const oVm = this.getView().getModel("vm");
      oVm.setProperty("/weekStartDate", this._addDays(oVm.getProperty("/weekStartDate"), 7));
      this._loadWeeklyGrid();
    },

    onPersonaChange: function (oEvent) {
      const sRole = oEvent.getParameter("selectedItem").getKey();
      const oTabBar = this.byId("mainTabBar");
      if (sRole === "ProjectManager") oTabBar.setSelectedKey("approvals");
      else if (sRole === "HRAdmin") oTabBar.setSelectedKey("analytics");
      else oTabBar.setSelectedKey("timesheet");
    },

    onTabSelect: function (oEvent) {
      const sKey = oEvent.getParameter("key");
      if (sKey === "approvals" || sKey === "analytics") {
        this._loadManagerData();
        this._refreshODataBindings();
      } else if (sKey === "leaves") {
        this._loadLeaves();
      }
    },

    // Formatter: derive avatar initials from full name (bound in XML)
    formatInitials: function (sName) {
      if (!sName) return "?";
      const aParts = sName.trim().split(/\s+/);
      const sFirst = aParts[0] ? aParts[0][0] : "";
      const sLast = aParts.length > 1 ? aParts[aParts.length - 1][0] : "";
      return (sFirst + sLast).toUpperCase();
    },

    // Formatter: approval status -> semantic state
    formatStatusState: function (sStatus) {
      if (sStatus === "POSTED_CATS" || sStatus === "APPROVED") return "Success";
      if (sStatus === "REJECTED") return "Error";
      if (sStatus === "SUBMITTED") return "Warning";
      return "Information";
    }
  });
});
