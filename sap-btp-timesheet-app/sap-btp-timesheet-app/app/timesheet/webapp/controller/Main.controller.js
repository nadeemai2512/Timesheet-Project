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
    "sap/ui/model/json/JSONModel"
], function (
    Controller, MessageBox, MessageToast, Dialog, Button, Label,
    Select, DatePicker, TextArea, VBox, Item, JSONModel
) {
    "use strict";

    return Controller.extend("com.company.timesheet.controller.Main", {

        onInit: function () {
            var oVm = this.getView().getModel("vm");
            if (!oVm) {
                oVm = new JSONModel(this._getInitialData());
                this.getView().setModel(oVm, "vm");
            } else if (!oVm.getData() || !oVm.getData().gridRows) {
                oVm.setData(this._getInitialData());
            }
            this._loadInitialData();
        },

        _getInitialData: function () {
            return {
                selectedPersona: "Employee",
                selectedEmployeeId: "EMP1001",
                employee: {},
                weekStartDate: this._getMonday(new Date()),
                weekLabel: "",
                header: { status: "DRAFT", totalHours: 0, billableHours: 0,
                          nonBillableHours: 0, overtimeHours: 0, catsDocumentId: "" },
                compliance: { officeDaysLogged: 0, officeTargetDays: 3, isAutoLocked: false },
                leaveBalance: { privilegeLeave: 0, casualLeave: 0, sickLeave: 0 },
                daysMeta: [], gridRows: [],
                allEmployeeLeaves: [], allPublicHolidays: [],
                teamSubmissions: [],
                managerAnalytics: {
                    utilizationBreakdown: [],
                    officeCompliance: [],
                    defaulterList: [],
                    employeeWorkStatus: [],
                    teamTimesheets: []
                },
                auditLogs: []
            };
        },

        _loadInitialData: async function () {
            try {
                await this._loadWeeklyGrid();
                await Promise.allSettled([
                    this._loadLeavesAndHolidays(),
                    this._loadManagerData()
                ]);
                this._updateChart();
            } catch (e) {
                MessageToast.show("Some backend data could not be loaded.");
            }
        },

        _getServiceUrl: function () {
            var oModel = this.getOwnerComponent().getModel();
            if (!oModel || !oModel.getServiceUrl) {
                throw new Error("Default OData model missing. Check manifest.json.");
            }
            var sUrl = oModel.getServiceUrl();
            if (!sUrl) throw new Error("CAP service URL not configured.");
            return sUrl.replace(/\/?$/, "/");
        },

        _request: async function (sPath, mOptions) {
            var mConfig = Object.assign({
                method: "GET", credentials: "same-origin",
                headers: { "Accept": "application/json" }
            }, mOptions || {});
            if (mConfig.body && typeof mConfig.body !== "string") {
                mConfig.body = JSON.stringify(mConfig.body);
            }
            if (mConfig.body) {
                mConfig.headers = Object.assign({}, mConfig.headers,
                    { "Content-Type": "application/json" });
            }
            var oResponse = await fetch(this._getServiceUrl() + sPath, mConfig);
            var sResponse = await oResponse.text();
            var oData = {};
            if (sResponse) {
                try { oData = JSON.parse(sResponse); }
                catch (e) { oData = { message: sResponse }; }
            }
            if (!oResponse.ok) {
                var sError = (oData.error && oData.error.message &&
                             (oData.error.message.value || oData.error.message)) ||
                             oData.message ||
                             "Backend failed. HTTP " + oResponse.status;
                throw new Error(sError);
            }
            return oData;
        },

        _addDays: function (sDate, iDays) {
            var oDate = new Date(sDate + "T00:00:00Z");
            oDate.setUTCDate(oDate.getUTCDate() + iDays);
            return oDate.toISOString().substring(0, 10);
        },
        _getMonday: function (oDate) {
            var oDay = new Date(Date.UTC(oDate.getFullYear(), oDate.getMonth(), oDate.getDate()));
            var iDay = oDay.getUTCDay();
            oDay.setUTCDate(oDay.getUTCDate() - (iDay === 0 ? 6 : iDay - 1));
            return oDay.toISOString().substring(0, 10);
        },
        _formatShortDate: function (sDate) {
            var oDate = new Date(sDate + "T00:00:00Z");
            return oDate.toLocaleDateString("en-GB",
                { day: "2-digit", month: "short", timeZone: "UTC" });
        },
        _formatDateRange: function (sStart) {
            return this._formatShortDate(sStart) + " - " +
                   this._formatShortDate(this._addDays(sStart, 6));
        },
        _escapeODataString: function (s) { return String(s).replace(/'/g, "''"); },

        _loadWeeklyGrid: async function () {
            var oVm = this.getView().getModel("vm");
            var sEmployeeId = oVm.getProperty("/selectedEmployeeId");
            var sWeekStart = oVm.getProperty("/weekStartDate");
            if (!sEmployeeId || !sWeekStart) {
                MessageBox.error("Employee ID or week start date missing.");
                return false;
            }
            oVm.setProperty("/weekLabel", this._formatDateRange(sWeekStart));
            try {
                var sEmp = this._escapeODataString(sEmployeeId);
                var sEndpoint = "getWeeklyGrid(employeeId='" + sEmp +
                                "',weekStartDate=" + sWeekStart + ")";
                var oData = await this._request(sEndpoint);

                try {
                    // FIXED: Wrap the ID in single quotes for the OData V4 Key predicate
                    var oEmployee = await this._request("Employees('" + sEmployeeId + "')");
                    oVm.setProperty("/employee", oEmployee || {});
                } catch (ex) { 
                    oVm.setProperty("/employee", {}); 
                }

                oVm.setProperty("/header", oData.header || {});
                oVm.setProperty("/assignments", oData.assignments || []);
                oVm.setProperty("/holidays", oData.holidays || []);
                oVm.setProperty("/approvedLeaves", oData.approvedLeaves || []);
                oVm.setProperty("/leaveBalance", oData.leaveBalance || {});
                oVm.setProperty("/compliance", oData.compliance || {});

                this._buildMatrixModel(oData);
                this._calculateSummary();
                return true;
            } catch (e) {
                // MessageBox.error("Unable to load weekly timesheet.\n\n" + (e.message || ""));
                // this._buildMatrixModel({ header: { status: "DRAFT" },
                //     assignments: [], holidays: [], approvedLeaves: [] });
                // return false;
            }
        },

        _buildMatrixModel: function (oData) {
            var oVm = this.getView().getModel("vm");
            var sWeekStart = oVm.getProperty("/weekStartDate");
            var aDayNames = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];
            var aHolidays = oData.holidays || [];
            var aLeaves = oData.approvedLeaves || [];
            var aEntries = (oData.header && oData.header.entries) || [];
            var aAssignments = oData.assignments || [];
            var oCompliance = oData.compliance || {};
            var oHeader = oData.header || {};
            var bEditable = !oCompliance.isAutoLocked &&
                (oHeader.status === "DRAFT" || oHeader.status === "REJECTED");

            var aDaysMeta = [];
            for (var i = 0; i < 7; i++) {
                var sDate = this._addDays(sWeekStart, i);
                var bWeekend = i >= 5;
                var oHoliday = aHolidays.find(function (h) {
                    return h.holidayDate === sDate && !h.isOptional;
                });
                var oLeave = aLeaves.find(function (l) {
                    return l.status === "APPROVED" && sDate >= l.startDate && sDate <= l.endDate;
                });
                var sType = "Working Day", sState = "Information", sNote = "Standard working day";
                if (bWeekend) { sType = "Weekend"; sState = "None"; sNote = "Weekly off"; }
                else if (oHoliday) { sType = "Holiday"; sState = "Success"; sNote = oHoliday.name; }
                else if (oLeave) { sType = "On Leave"; sState = "Warning"; sNote = oLeave.leaveType; }
                aDaysMeta.push({
                    date: sDate, shortDate: this._formatShortDate(sDate),
                    dayName: aDayNames[i], isWeekend: bWeekend,
                    isHoliday: Boolean(oHoliday), isLeave: Boolean(oLeave),
                    dayTypeLabel: sType, dayState: sState, note: sNote
                });
            }
            oVm.setProperty("/daysMeta", aDaysMeta);

            var mRows = new Map();
            aAssignments.forEach(function (a) {
                var p = a.project;
                if (p && p.status === "ACTIVE") {
                    mRows.set(p.ID, this._createProjectRow(p, aDaysMeta, bEditable));
                }
            }.bind(this));

            aEntries.forEach(function (e) {
                if (!mRows.has(e.project_ID) && e.project) {
                    mRows.set(e.project_ID, this._createProjectRow(e.project, aDaysMeta, bEditable));
                }
                var oRow = mRows.get(e.project_ID);
                if (!oRow) return;
                if (e.taskCategory) oRow.taskCategory = e.taskCategory;
                if (e.remarks) oRow.remarks = e.remarks;
                var oCell = oRow.days.find(function (d) { return d.workDate === e.workDate; });
                if (oCell) {
                    oCell.entryId = e.ID;
                    oCell.hours = Number(e.hours || 0);
                    oCell.workMode = e.workMode || "IN_OFFICE";
                }
            }.bind(this));

            var aRows = Array.from(mRows.values());
            aRows.forEach(function (r) {
                r.rowTotal = r.days.reduce(function (s, d) { return s + Number(d.hours || 0); }, 0);
            });
            oVm.setProperty("/gridRows", aRows);
        },

        _createProjectRow: function (oProject, aDaysMeta, bEditable) {
            return {
                projectId: oProject.ID,
                projectName: oProject.name,
                wbsElement: oProject.wbsElement,
                isBillable: Boolean(oProject.isBillable),
                taskCategory: "Development",
                remarks: "",
                rowTotal: 0,
                days: aDaysMeta.map(function (d) {
                    return {
                        entryId: null, workDate: d.date, dayOfWeek: d.dayName,
                        hours: 0, workMode: "IN_OFFICE",
                        isLeave: d.isLeave, isHoliday: d.isHoliday,
                        editable: bEditable && !d.isWeekend && !d.isHoliday && !d.isLeave
                    };
                })
            };
        },

        onCellChanged: function (oEvent) {
            var oControl = oEvent.getSource();
            var oContext = oControl.getBindingContext("vm");
            if (!oContext) return;
            var oValueBinding = oControl.getBinding("value");
            var oKeyBinding = oControl.getBinding("selectedKey");
            var sPath = oValueBinding ? oValueBinding.getPath()
                                    : (oKeyBinding ? oKeyBinding.getPath() : "");
            if (!sPath) return;
            var oVm = this.getView().getModel("vm");
            var oRow = oContext.getObject();
            if (sPath.indexOf("/hours") !== -1) {
                var fHours = Number(oControl.getValue());
                if (!Number.isFinite(fHours) || fHours < 0 || fHours > 24) {
                    MessageToast.show("Enter 0-24 hours.");
                    oControl.setValue("0"); fHours = 0;
                }
                var iDayIndex = parseInt(sPath.match(/days\/(\d+)/)[1], 10);
                oVm.setProperty(oContext.getPath() + "/days/" + iDayIndex + "/hours", fHours);
            }
            oRow.rowTotal = oRow.days.reduce(function (s, d) { return s + Number(d.hours || 0); }, 0);
            oVm.setProperty(oContext.getPath() + "/rowTotal", oRow.rowTotal);
            this._calculateSummary();
        },

        _calculateSummary: function () {
            var oVm = this.getView().getModel("vm");
            var aRows = oVm.getProperty("/gridRows") || [];
            var fTotal = 0, fBillable = 0, fNonBillable = 0, fOvertime = 0;
            var oOfficeSet = new Set();
            aRows.forEach(function (row) {
                var fRowTotal = 0;
                row.days.forEach(function (d) {
                    var h = Number(d.hours || 0);
                    fRowTotal += h;
                    if (h > 0 && d.workMode === "IN_OFFICE" &&
                        !d.isWeekend && !d.isHoliday && !d.isLeave) {
                        oOfficeSet.add(d.workDate);
                    }
                });
                row.rowTotal = fRowTotal;
                fTotal += fRowTotal;
                row.isBillable ? (fBillable += fRowTotal) : (fNonBillable += fRowTotal);
            });
            var aDayTotals = {};
            aRows.forEach(function (row) {
                row.days.forEach(function (d) {
                    aDayTotals[d.workDate] = (aDayTotals[d.workDate] || 0) + Number(d.hours || 0);
                });
            });
            Object.keys(aDayTotals).forEach(function (k) {
                fOvertime += Math.max(0, aDayTotals[k] - 8);
            });
            oVm.setProperty("/gridRows", aRows);
            oVm.setProperty("/header/totalHours", fTotal);
            oVm.setProperty("/header/billableHours", fBillable);
            oVm.setProperty("/header/nonBillableHours", fNonBillable);
            oVm.setProperty("/header/overtimeHours", fOvertime);
            oVm.setProperty("/compliance/officeDaysLogged", oOfficeSet.size);
        },

        onSaveDraft: async function () {
            var oVm = this.getView().getModel("vm");
            var sHeaderId = oVm.getProperty("/header/ID");
            var aRows = oVm.getProperty("/gridRows") || [];
            if (!sHeaderId) {
                MessageBox.error("No timesheet header exists for this week.");
                return false;
            }
            try {
                for (var r = 0; r < aRows.length; r++) {
                    var row = aRows[r];
                    for (var i = 0; i < 5; i++) {
                        var c = row.days[i];
                        if (!c.editable) continue;
                        var fH = Number(c.hours || 0);
                        if (c.entryId) {
                            await this._request("TimesheetEntries(" + c.entryId + ")", {
                                method: "PATCH",
                                body: { hours: fH, workMode: c.workMode,
                                        taskCategory: row.taskCategory, remarks: row.remarks }
                            });
                        } else if (fH > 0) {
                            var created = await this._request("TimesheetEntries", {
                                method: "POST",
                                body: { header_ID: sHeaderId, project_ID: row.projectId,
                                        workDate: c.workDate, dayOfWeek: c.dayOfWeek,
                                        hours: fH, workMode: c.workMode,
                                        taskCategory: row.taskCategory, remarks: row.remarks }
                            });
                            c.entryId = created.ID;
                        }
                    }
                }
                MessageToast.show("Draft saved.");
                await this._loadWeeklyGrid();
                await this._loadManagerData();
                return true;
            } catch (e) {
                MessageBox.error(e.message, { title: "Validation Error" });
                return false;
            }
        },

        onSubmitTimesheet: async function () {
            if (!(await this.onSaveDraft())) return;
            var oVm = this.getView().getModel("vm");
            var sHeaderId = oVm.getProperty("/header/ID");
            if (!sHeaderId) { MessageBox.error("Header ID missing."); return; }
            try {
                await this._request(
                    "TimesheetHeaders(" + sHeaderId + ")/TimesheetService.submitTimesheet",
                    { method: "POST", body: {} });
                MessageBox.success("Submitted for manager approval.");
                await this._loadWeeklyGrid();
                await this._loadManagerData();
            } catch (e) {
                MessageBox.error(e.message, { title: "Submission Failed" });
            }
        },

        onCopyPreviousWeek: async function () {
            var oVm = this.getView().getModel("vm");
            try {
                await this._request("copyPreviousWeek", {
                    method: "POST",
                    body: { employeeId: oVm.getProperty("/selectedEmployeeId"),
                            targetWeekStartDate: oVm.getProperty("/weekStartDate") }
                });
                MessageToast.show("Copied previous week.");
                await this._loadWeeklyGrid();
            } catch (e) { MessageBox.error(e.message); }
        },

        onPrevWeek: async function () {
            var oVm = this.getView().getModel("vm");
            oVm.setProperty("/weekStartDate",
                this._addDays(oVm.getProperty("/weekStartDate"), -7));
            await this._loadWeeklyGrid();
        },
        onNextWeek: async function () {
            var oVm = this.getView().getModel("vm");
            oVm.setProperty("/weekStartDate",
                this._addDays(oVm.getProperty("/weekStartDate"), 7));
            await this._loadWeeklyGrid();
        },
        onOpenAddRowDialog: function () {
            MessageToast.show("Active projects loaded from backend assignments.");
        },

        _loadLeavesAndHolidays: async function () {
            var oVm = this.getView().getModel("vm");
            var sEmp = this._escapeODataString(oVm.getProperty("/selectedEmployeeId"));
            var aResults = await Promise.allSettled([
                this._request("EmployeeLeaves?$filter=employee_ID eq '" + sEmp +
                              "'&$orderby=startDate desc"),
                this._request("PublicHolidays?$orderby=holidayDate asc")
            ]);
            if (aResults[0].status === "fulfilled") {
                oVm.setProperty("/allEmployeeLeaves", aResults[0].value.value || []);
            }
            if (aResults[1].status === "fulfilled") {
                oVm.setProperty("/allPublicHolidays", aResults[1].value.value || []);
            }
        },

        onOpenApplyLeaveDialog: function () {
            var oTypeSelect = new Select({
                width: "100%", selectedKey: "Privilege Leave",
                items: [
                    new Item({ key: "Privilege Leave", text: "Privilege Leave (PL)" }),
                    new Item({ key: "Casual Leave", text: "Casual Leave (CL)" }),
                    new Item({ key: "Sick Leave", text: "Sick Leave (SL)" })
                ]
            });
            var sToday = new Date().toISOString().substring(0, 10);
            var oStartPicker = new DatePicker({
                width: "100%", valueFormat: "yyyy-MM-dd",
                displayFormat: "dd MMM yyyy", value: sToday
            });
            var oEndPicker = new DatePicker({
                width: "100%", valueFormat: "yyyy-MM-dd",
                displayFormat: "dd MMM yyyy", value: sToday
            });
            var oReason = new TextArea({ width: "100%", rows: 3,
                placeholder: "Enter reason..." });
            var oDialog = new Dialog({
                title: "Apply for Leave", contentWidth: "430px",
                draggable: true, resizable: true,
                content: new VBox({
                    class: "sapUiMediumMargin",
                    items: [
                        new Label({ text: "Leave Type" }), oTypeSelect,
                        new Label({ text: "Start Date", required: true })
                            .addStyleClass("sapUiTinyMarginTop"), oStartPicker,
                        new Label({ text: "End Date", required: true })
                            .addStyleClass("sapUiTinyMarginTop"), oEndPicker,
                        new Label({ text: "Reason", required: true })
                            .addStyleClass("sapUiTinyMarginTop"), oReason
                    ]
                }),
                beginButton: new Button({
                    text: "Submit", type: "Emphasized",
                    press: async function () {
                        var sStart = oStartPicker.getValue();
                        var sEnd = oEndPicker.getValue();
                        var sReason = oReason.getValue().trim();
                        if (!sStart || !sEnd || !sReason) {
                            MessageToast.show("Complete all mandatory fields."); return;
                        }
                        if (sEnd < sStart) { MessageBox.error("End before start."); return; }
                        try {
                            var oVm = this.getView().getModel("vm");
                            await this._request("applyLeave", {
                                method: "POST",
                                body: {
                                    employeeId: oVm.getProperty("/selectedEmployeeId"),
                                    leaveType: oTypeSelect.getSelectedKey(),
                                    startDate: sStart, endDate: sEnd, reason: sReason
                                }
                            });
                            MessageToast.show("Leave submitted.");
                            oDialog.close();
                            await this._loadLeavesAndHolidays();
                            await this._loadWeeklyGrid();
                        } catch (e) { MessageBox.error(e.message); }
                    }.bind(this)
                }),
                endButton: new Button({
                    text: "Cancel", press: function () { oDialog.close(); }
                }),
                afterClose: function () { oDialog.destroy(); }
            });
            this.getView().addDependent(oDialog);
            oDialog.open();
        },

        _loadManagerData: async function () {
            var oVm = this.getView().getModel("vm");
            try {
                var aResults = await Promise.allSettled([
                    this._request("getManagerAnalytics()"),
                    this._request("AuditLogs?$orderby=performedAt desc")
                ]);

                if (aResults[0].status === "fulfilled") {
                    var oAnalytics = aResults[0].value || {};
                    oVm.setProperty("/managerAnalytics", oAnalytics);
                    oVm.setProperty("/teamSubmissions", oAnalytics.teamTimesheets || []);
                } else {
                    try {
                        var headers = await this._request(
                            "TimesheetHeaders?$expand=employee&$orderby=weekStartDate desc");
                        var mapped = (headers.value || []).map(function (h) {
                            return {
                                ID: h.ID,
                                employeeName: h.employee ? h.employee.fullName : '',
                                employeeId: h.employee_ID,
                                department: h.employee ? h.employee.department : '',
                                weekStartDate: h.weekStartDate,
                                weekEndDate: h.weekEndDate,
                                totalHours: h.totalHours,
                                billableHours: h.billableHours,
                                officeDaysCount: h.officeDaysCount,
                                workStatus: h.status,
                                status: h.status,
                                catsDocumentId: h.catsDocumentId || ''
                            };
                        });
                        oVm.setProperty("/teamSubmissions", mapped);
                    } catch (e2) {
                        oVm.setProperty("/teamSubmissions", []);
                    }
                }

                if (aResults[1].status === "fulfilled") {
                    oVm.setProperty("/auditLogs", aResults[1].value.value || []);
                }

                this._updateChart();
                return true;
            } catch (e) {
                MessageToast.show("Manager analytics unavailable.");
                return false;
            }
        },

        _updateChart: function () {
            var oChart = this.byId("utilizationChart");
            if (!oChart) return;
            oChart.setVizProperties({
                title: { visible: true, text: "Hours Distribution" },
                legend: { visible: true, position: "bottom" },
                plotArea: { drawingEffect: "glossy" },
                tooltip: { visible: true }
            });
        },

        onBulkApprove: async function () {
            var oTable = this.byId("approvalTable");
            var aSelected = oTable.getSelectedItems();
            if (!aSelected.length) { MessageToast.show("Select at least one row."); return; }
            var aIds = aSelected
                .map(function (it) { return it.getBindingContext("vm").getObject().ID; })
                .filter(Boolean);
            if (!aIds.length) {
                MessageToast.show("Selected rows have no submitted timesheet headers yet.");
                return;
            }
            try {
                await this._request("bulkApproveTimesheets", {
                    method: "POST",
                    body: { headerIds: aIds, comments: "Approved by Project Manager" }
                });
                MessageBox.success(aIds.length + " timesheet(s) approved.");
                oTable.removeSelections(true);
                await this._loadManagerData();
            } catch (e) { MessageBox.error(e.message); }
        },

        onOpenRejectDialog: function () {
            var oTable = this.byId("approvalTable");
            var aSelected = oTable.getSelectedItems();
            if (aSelected.length !== 1) {
                MessageToast.show("Select exactly one timesheet."); return;
            }
            var sHeaderId = aSelected[0].getBindingContext("vm").getObject().ID;
            if (!sHeaderId) {
                MessageToast.show("Selected employee has no timesheet header."); return;
            }
            var oReason = new TextArea({ width: "100%", rows: 4,
                placeholder: "Enter rejection reason..." });
            var oDialog = new Dialog({
                title: "Reject Timesheet", contentWidth: "420px",
                content: new VBox({
                    class: "sapUiMediumMargin",
                    items: [ new Label({ text: "Reason", required: true }), oReason ]
                }),
                beginButton: new Button({
                    text: "Reject", type: "Reject",
                    press: async function () {
                        var sReason = oReason.getValue().trim();
                        if (!sReason) { MessageToast.show("Reason required."); return; }
                        try {
                            await this._request(
                                "TimesheetHeaders(" + sHeaderId +
                                ")/TimesheetService.rejectTimesheet",
                                { method: "POST", body: { rejectionReason: sReason } });
                            MessageToast.show("Rejected.");
                            oDialog.close();
                            oTable.removeSelections(true);
                            await this._loadManagerData();
                        } catch (e) { MessageBox.error(e.message); }
                    }.bind(this)
                }),
                endButton: new Button({
                    text: "Cancel", press: function () { oDialog.close(); }
                }),
                afterClose: function () { oDialog.destroy(); }
            });
            this.getView().addDependent(oDialog);
            oDialog.open();
        },

        onHrUnlockSelected: async function () {
            var oTable = this.byId("approvalTable");
            var aSelected = oTable.getSelectedItems();
            if (aSelected.length !== 1) {
                MessageToast.show("Select one timesheet."); return;
            }
            var sHeaderId = aSelected[0].getBindingContext("vm").getObject().ID;
            if (!sHeaderId) { MessageToast.show("No header to unlock."); return; }
            try {
                await this._request(
                    "TimesheetHeaders(" + sHeaderId + ")/TimesheetService.unlockTimesheet",
                    { method: "POST", body: { hrRemarks: "Unlocked by HR Admin" } });
                MessageToast.show("Unlocked.");
                oTable.removeSelections(true);
                await this._loadManagerData();
                if (sHeaderId === this.getView().getModel("vm").getProperty("/header/ID")) {
                    await this._loadWeeklyGrid();
                }
            } catch (e) { MessageBox.error(e.message); }
        },

        onPersonaChange: function (oEvent) {
            var oItem = oEvent.getParameter("selectedItem");
            if (!oItem) return;
            var sRole = oItem.getKey();
            var oVm = this.getView().getModel("vm");
            oVm.setProperty("/selectedPersona", sRole);
            var oTabBar = this.byId("mainTabBar");
            if (sRole === "ProjectManager") {
                oTabBar.setSelectedKey("approvals");
                this._loadManagerData();
            } else if (sRole === "HRAdmin") {
                oTabBar.setSelectedKey("analytics");
                this._loadManagerData();
            } else {
                oTabBar.setSelectedKey("timesheet");
                this._loadWeeklyGrid();
            }
        },

        onTabSelect: function (oEvent) {
            var sKey = oEvent.getParameter("key");
            if (sKey === "approvals" || sKey === "analytics") this._loadManagerData();
            else if (sKey === "leaves") this._loadLeavesAndHolidays();
        }
    });
});
