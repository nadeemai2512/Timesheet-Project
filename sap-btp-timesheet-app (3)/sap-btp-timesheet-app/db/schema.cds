namespace com.company.timesheet;

using { cuid, managed } from '@sap/cds/common';

type WorkMode : String(20) enum {
  InOffice    = 'IN_OFFICE';
  WFH         = 'WFH';
  ClientSite  = 'CLIENT_SITE';
  OnDuty      = 'ON_DUTY';
};

type TaskCategory : String(30) enum {
  Development = 'Development';
  Testing     = 'Testing';
  Meetings    = 'Meetings';
  Admin       = 'Admin';
  Architecture= 'Architecture';
  Support     = 'Support';
};

type ApprovalStatus : String(20) enum {
  Draft       = 'DRAFT';
  Submitted   = 'SUBMITTED';
  Approved    = 'APPROVED';
  Rejected    = 'REJECTED';
  PostedCATS  = 'POSTED_CATS';
};

type LeaveType : String(30) enum {
  PrivilegeLeave = 'Privilege Leave';
  SickLeave      = 'Sick Leave';
  CasualLeave    = 'Casual Leave';
  OptionalHoliday= 'Optional Holiday';
};

entity Employees : managed {
  key ID               : String(10); // e.g., EMP1001
      fullName         : String(100);
      email            : String(100);
      role             : String(50);
      department       : String(60);
      location         : String(50); // e.g., Hyderabad, IN
      manager          : Association to Employees;
      costCenter       : String(20);
      officeTargetDays : Integer default 3; // 3-days-a-week policy
      assignments      : Composition of many ProjectAssignments on assignments.employee = $self;
      leaves           : Composition of many EmployeeLeaves on leaves.employee = $self;
      timesheets       : Composition of many TimesheetHeaders on timesheets.employee = $self;
}

entity Projects : managed {
  key ID               : String(20); // WBS Element ID e.g., PRJ-S4-001
      wbsElement       : String(24);
      name             : String(120);
      clientName       : String(100);
      isBillable       : Boolean default true;
      poNumber         : String(20);
      poExpiryDate     : Date;
      budgetHours      : Decimal(10,2);
      consumedHours    : Decimal(10,2) default 0;
      status           : String(20) default 'ACTIVE'; // ACTIVE, CLOSED
      projectManager   : Association to Employees;
      startDate        : Date;
      endDate          : Date;
}

entity ProjectAssignments : cuid, managed {
  employee        : Association to Employees;
  project         : Association to Projects;
  validFrom       : Date;
  validTo         : Date;
  allocatedHours  : Decimal(6,2);
}

entity PublicHolidays {
  key ID          : UUID;
      holidayDate : Date;
      region      : String(30); // e.g., IN-TG (India / Hyderabad)
      name        : String(100);
      isOptional  : Boolean default false;
}

entity EmployeeLeaves : cuid, managed {
  employee        : Association to Employees;
  leaveType       : LeaveType;
  startDate       : Date;
  endDate         : Date;
  daysCount       : Decimal(4,1);
  status          : String(20); // APPROVED, PENDING, REJECTED
  sfLeaveId       : String(30); // SAP SuccessFactors Leave Reference ID
  reason          : String(255);
}

entity LeaveBalances {
  key ID              : UUID;
      employee        : Association to Employees;
      year            : Integer;
      privilegeLeave  : Decimal(4,1);
      sickLeave       : Decimal(4,1);
      casualLeave     : Decimal(4,1);
}

entity TimesheetHeaders : cuid, managed {
  employee          : Association to Employees;
  weekStartDate     : Date; // Always Monday
  weekEndDate       : Date; // Always Sunday
  totalHours        : Decimal(5,2) default 0;
  billableHours     : Decimal(5,2) default 0;
  nonBillableHours  : Decimal(5,2) default 0;
  overtimeHours     : Decimal(5,2) default 0;
  officeDaysCount   : Integer default 0;
  status            : ApprovalStatus default 'DRAFT';
  submittedAt       : Timestamp;
  approvedBy        : String(100);
  approvedAt        : Timestamp;
  rejectionReason   : String(500);
  isLocked          : Boolean default false;
  catsDocumentId    : String(30); // SAP S/4HANA CATS Posting Document Ref
  workflowInstanceId: String(64); // SAP Build Process Automation Instance ID
  entries           : Composition of many TimesheetEntries on entries.header = $self;
}

entity TimesheetEntries : cuid, managed {
  header          : Association to TimesheetHeaders;
  project         : Association to Projects;
  workDate        : Date;
  dayOfWeek       : String(10); // Mon, Tue, Wed, Thu, Fri, Sat, Sun
  hours           : Decimal(4,2) default 0;
  workMode        : WorkMode default 'IN_OFFICE';
  taskCategory    : TaskCategory default 'Development';
  remarks         : String(500);
  entryStatus     : ApprovalStatus default 'DRAFT';
  rejectionNote   : String(300);
}

entity AuditLogs : cuid {
  entityName      : String(50);
  entityId        : String(36);
  action          : String(30); // CREATE, UPDATE, SUBMIT, APPROVE, REJECT, UNLOCK, CATS_POST
  performedBy     : String(100);
  performedAt     : Timestamp;
  details         : String(1000);
}
