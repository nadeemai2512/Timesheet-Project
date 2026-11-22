sap.ui.define([
  "sap/ui/core/UIComponent",
  "sap/ui/Device",
  "sap/ui/model/json/JSONModel"
], function (UIComponent, Device, JSONModel) {
  "use strict";

  return UIComponent.extend("com.company.timesheet.Component", {
    metadata: {
      manifest: "json"
    },

    init: function () {
      UIComponent.prototype.init.apply(this, arguments);

      // Device Model for Responsive Mobile/Desktop adaptation
      const oDeviceModel = new JSONModel(Device);
      oDeviceModel.setDefaultBindingMode("OneWay");
      this.setModel(oDeviceModel, "device");

      // Local View State Model (JSONModel) — holds computed/custom-function
      // payloads (weekly grid matrix, KPI totals, analytics) that cannot be
      // expressed as a plain OData V4 list binding. Entity-backed lists
      // (Employees, TimesheetHeaders, EmployeeLeaves, PublicHolidays, AuditLogs)
      // are bound directly to the default OData V4 model declared in manifest.json.
      const oViewModel = new JSONModel({
        selectedEmployeeId: "EMP1001",
        selectedPersona: "Employee",
        weekStartDate: "2026-11-16",
        weekLabel: "",
        header: {},
        gridRows: [],
        daysMeta: [],
        assignments: [],
        holidays: [],
        approvedLeaves: [],
        leaveBalance: {},
        compliance: {},
        monthlySummary: {},
        managerAnalytics: {
          utilizationBreakdown: [],
          officeCompliance: [],
          defaulterList: []
        },
        teamSubmissions: [],
        auditLogs: [],
        busy: false
      });
      oViewModel.setSizeLimit(1000);
      this.setModel(oViewModel, "vm");

      this.getRouter().initialize();
    }
  });
});
