using { com.company.timesheet as db } from '../db/schema';

service TimesheetService @(path: '/odata/v4/timesheet') {

  // Master Data & Reference Views
  @readonly entity Employees as projection on db.Employees;
  @readonly entity Projects as projection on db.Projects;
  @readonly entity ProjectAssignments as projection on db.ProjectAssignments;
  @readonly entity PublicHolidays as projection on db.PublicHolidays;
  entity EmployeeLeaves as projection on db.EmployeeLeaves;
  @readonly entity LeaveBalances as projection on db.LeaveBalances;
  @readonly entity AuditLogs as projection on db.AuditLogs;

  // Transactional Entities
  entity TimesheetHeaders as projection on db.TimesheetHeaders
    actions {
      action submitTimesheet() returns TimesheetHeaders;
      action approveTimesheet(comments: String) returns TimesheetHeaders;
      action rejectTimesheet(rejectionReason: String) returns TimesheetHeaders;
      action unlockTimesheet(hrRemarks: String) returns TimesheetHeaders;
      action postToCATS() returns TimesheetHeaders;
    };

  entity TimesheetEntries as projection on db.TimesheetEntries;

  // Custom Functions & Actions for UI5 Productivity & Analytics
  function getWeeklyGrid(employeeId: String, weekStartDate: Date) returns {
    header          : TimesheetHeaders;
    assignments     : array of ProjectAssignments;
    holidays        : array of PublicHolidays;
    approvedLeaves  : array of EmployeeLeaves;
    leaveBalance    : LeaveBalances;
    compliance      : {
      isCutoffPassed   : Boolean;
      isAutoLocked     : Boolean;
      officeDaysLogged : Integer;
      officeTargetDays : Integer;
    };
  };

  action copyPreviousWeek(employeeId: String, targetWeekStartDate: Date) returns TimesheetHeaders;
  action bulkApproveTimesheets(headerIds: array of String, comments: String) returns Integer;
  action applyLeave(employeeId: String, leaveType: String, startDate: Date, endDate: Date, reason: String) returns EmployeeLeaves;

  // FR-05 Analytics & Reporting Dashboard Endpoints
  function getEmployeeMonthlySummary(employeeId: String, year: Integer, month: Integer) returns {
    totalHours       : Decimal(6,2);
    billableHours    : Decimal(6,2);
    nonBillableHours : Decimal(6,2);
    overtimeHours    : Decimal(6,2);
    inOfficeDays     : Integer;
    wfhDays          : Integer;
    clientSiteDays   : Integer;
    leaveDaysTaken   : Decimal(4,1);
    officeRatioPct   : Decimal(5,2);
  };

  function getManagerAnalytics() returns {
    utilizationBreakdown : array of {
      category : String;
      hours    : Decimal(8,2);
    };
    officeCompliance     : array of {
      employeeName : String;
      officeDays   : Integer;
      targetDays   : Integer;
      status       : String;
    };
    defaulterList        : array of {
      employeeId   : String;
      employeeName : String;
      department   : String;
      weekStart    : Date;
      status       : String;
      daysOverdue  : Integer;
    };
  };
}
