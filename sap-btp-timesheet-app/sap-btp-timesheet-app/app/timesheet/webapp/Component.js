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

      // Local View State Model
      const oViewModel = new JSONModel({
        selectedEmployeeId: "EMP1001",
        selectedPersona: "Employee",
        weekStartDate: "2026-11-16",
        weekLabel: "16 Nov 2026 – 22 Nov 2026",
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
        auditLogs: []
      });
      this.setModel(oViewModel, "vm");

      this.getRouter().initialize();
    }
  });
});
