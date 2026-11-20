const cds = require('@sap/cds');

module.exports = cds.service.impl(async function () {
  const {
    Employees,
    Projects,
    ProjectAssignments,
    PublicHolidays,
    EmployeeLeaves,
    LeaveBalances,
    TimesheetHeaders,
    TimesheetEntries,
    AuditLogs
  } = this.entities;

  // Helper: Format YYYY-MM-DD
  const toISODate = (d) => new Date(d).toISOString().split('T')[0];

  // Helper: Get Monday of a given date
  const getMonday = (dateStr) => {
    const d = new Date(dateStr + 'T00:00:00Z');
    const day = d.getUTCDay();
    const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1);
    d.setUTCDate(diff);
    return toISODate(d);
  };

  // Helper: Add days to YYYY-MM-DD
  const addDays = (dateStr, days) => {
    const d = new Date(dateStr + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + days);
    return toISODate(d);
  };

  // Helper: Write immutable Audit Trail to SAP HANA Cloud
  const logAudit = async (tx, entityName, entityId, action, user, details) => {
    await tx.run(
      INSERT.into(AuditLogs).entries({
        entityName,
        entityId: String(entityId),
        action,
        performedBy: user || 'emp.ravi@company.com',
        performedAt: new Date().toISOString(),
        details
      })
    );
  };

  // Helper: Recalculate Header Totals (Total, Billable, Non-Billable, Overtime, Office Days)
  const recalculateHeader = async (tx, headerId) => {
    const entries = await tx.run(
      SELECT.from(TimesheetEntries).where({ header_ID: headerId })
    );
    const projects = await tx.run(SELECT.from(Projects));
    const projMap = new Map(projects.map((p) => [p.ID, p]));

    let totalHours = 0;
    let billableHours = 0;
    let nonBillableHours = 0;
    const dailyTotals = {};
    const officeDates = new Set();

    for (const e of entries) {
      const hrs = Number(e.hours || 0);
      if (hrs <= 0) continue;

      totalHours += hrs;
      const proj = projMap.get(e.project_ID);
      if (proj && proj.isBillable) {
        billableHours += hrs;
      } else {
        nonBillableHours += hrs;
      }

      dailyTotals[e.workDate] = (dailyTotals[e.workDate] || 0) + hrs;

      if (e.workMode === 'IN_OFFICE' || e.workMode === 'CLIENT_SITE') {
        officeDates.add(e.workDate);
      }
    }

    let overtimeHours = 0;
    for (const dateKey of Object.keys(dailyTotals)) {
      if (dailyTotals[dateKey] > 8) {
        overtimeHours += dailyTotals[dateKey] - 8;
      }
    }

    await tx.run(
      UPDATE(TimesheetHeaders)
        .set({
          totalHours,
          billableHours,
          nonBillableHours,
          overtimeHours,
          officeDaysCount: officeDates.size
        })
        .where({ ID: headerId })
    );
  };

  // =========================================================================
  // FR-02: AUTOMATED VALIDATIONS ON TIMESHEET ENTRY CREATE / UPDATE
  // =========================================================================
  this.before(['CREATE', 'UPDATE'], TimesheetEntries, async (req) => {
    const tx = cds.tx(req);
    const data = req.data;

    let existing = {};
    if (req.event === 'UPDATE' && data.ID) {
      existing = await tx.run(SELECT.one.from(TimesheetEntries).where({ ID: data.ID })) || {};
    }

    const headerId = data.header_ID || existing.header_ID;
    const projectId = data.project_ID || existing.project_ID;
    const workDate = data.workDate || existing.workDate;
    const hours = data.hours !== undefined ? Number(data.hours) : Number(existing.hours || 0);
    const remarks = data.remarks !== undefined ? data.remarks : existing.remarks;

    if (!headerId || !projectId || !workDate) return;

    const header = await tx.run(SELECT.one.from(TimesheetHeaders).where({ ID: headerId }));
    if (!header) req.reject(404, 'Timesheet header not found.');

    // Rule 1: 15-Day Auto-Lock & Submitted/Approved Lock Check
    if (header.isLocked) {
      req.reject(403, 'This timesheet is locked (older than 15 days or posted to CATS). Contact HR Admin to unlock.');
    }
    if (header.status === 'APPROVED' || header.status === 'POSTED_CATS') {
      req.reject(400, `Cannot modify entries when timesheet status is ${header.status}.`);
    }

    // Rule 2: Weekend Check
    const dayNum = new Date(workDate + 'T00:00:00Z').getUTCDay();
    if (dayNum === 0 || dayNum === 6) {
      req.reject(400, `Date ${workDate} is a weekend. Weekend logging requires special HR override.`);
    }

    // Rule 3: Public Holiday Sync Check (India/Hyderabad Calendar)
    const holiday = await tx.run(
      SELECT.one.from(PublicHolidays).where({ holidayDate: workDate, isOptional: false })
    );
    if (holiday && hours > 0) {
      req.reject(400, `Cannot log project hours on mandatory Public Holiday: ${holiday.name} (${workDate}).`);
    }

    // Rule 4: Approved Leave Lock Check (SAP SuccessFactors Sync)
    const approvedLeave = await tx.run(
      SELECT.one.from(EmployeeLeaves).where({
        employee_ID: header.employee_ID,
        status: 'APPROVED',
        startDate: { '<=': workDate },
        endDate: { '>=': workDate }
      })
    );
    if (approvedLeave && hours > 0) {
      req.reject(
        400,
        `Date ${workDate} is locked due to an Approved ${approvedLeave.leaveType} (${approvedLeave.sfLeaveId}).`
      );
    }

    // Rule 5: Project Budget, Status, PO Expiry & Assignment Window Check
    const project = await tx.run(SELECT.one.from(Projects).where({ ID: projectId }));
    if (!project) req.reject(404, `Project ${projectId} does not exist.`);

    if (project.status !== 'ACTIVE') {
      req.reject(400, `Project "${project.name}" (${project.wbsElement}) is CLOSED. Hours cannot be logged.`);
    }
    if (project.poExpiryDate && workDate > project.poExpiryDate) {
      req.reject(400, `Purchase Order ${project.poNumber} expired on ${project.poExpiryDate}.`);
    }
    if (Number(project.consumedHours) + hours > Number(project.budgetHours)) {
      req.reject(400, `Project budget exceeded for ${project.wbsElement} (Remaining: ${project.budgetHours - project.consumedHours} hrs).`);
    }

    const assignment = await tx.run(
      SELECT.one.from(ProjectAssignments).where({
        employee_ID: header.employee_ID,
        project_ID: projectId,
        validFrom: { '<=': workDate },
        validTo: { '>=': workDate }
      })
    );
    if (!assignment) {
      req.reject(400, `Employee is not assigned to project ${project.wbsElement} on ${workDate}.`);
    }

    // Rule 6: Daily Hour Cap (Max 12h) & Mandatory Remarks for Overtime (> 8h/day)
    const siblingEntries = await tx.run(
      SELECT.from(TimesheetEntries).where({ header_ID: headerId, workDate })
    );
    const otherHours = siblingEntries
      .filter((e) => e.ID !== data.ID)
      .reduce((sum, e) => sum + Number(e.hours || 0), 0);

    const totalDayHours = otherHours + hours;
    if (totalDayHours > 12) {
      req.reject(400, `Daily limit exceeded (${totalDayHours}h). Maximum allowed is 12 hours per day without special approval.`);
    }
    if (totalDayHours > 8 && (!remarks || remarks.trim().length < 5)) {
      req.reject(400, `Overtime detected (${totalDayHours}h on ${workDate}). Mandatory remarks (min 5 chars) are required.`);
    }
  });

  this.after(['CREATE', 'UPDATE', 'DELETE'], TimesheetEntries, async (data, req) => {
    const tx = cds.tx(req);
    if (data && data.header_ID) {
      await recalculateHeader(tx, data.header_ID);
    }
  });

  // =========================================================================
  // FR-01 & FR-02: GET WEEKLY GRID (PROJECTS + WORK ENTRIES + LEAVES + HOLIDAYS)
  // =========================================================================
  this.on('getWeeklyGrid', async (req) => {
    const tx = cds.tx(req);
    const employeeId = req.data.employeeId || 'EMP1001';
    const weekStartDate = getMonday(req.data.weekStartDate || '2026-11-16');
    const weekEndDate = addDays(weekStartDate, 6);

    const employee = await tx.run(SELECT.one.from(Employees).where({ ID: employeeId }));
    if (!employee) req.reject(404, `Employee ${employeeId} not found.`);

    // Auto-lock check: Entries older than 15 days lock automatically
    const today = new Date('2026-11-20T00:00:00Z');
    const weekEndObj = new Date(weekEndDate + 'T00:00:00Z');
    const daysSinceWeekEnd = Math.floor((today - weekEndObj) / (1000 * 60 * 60 * 24));
    const isAutoLocked = daysSinceWeekEnd > 15;

    let header = await tx.run(
      SELECT.one.from(TimesheetHeaders).where({ employee_ID: employeeId, weekStartDate })
    );

    if (!header) {
      const newId = cds.utils.uuid();
      await tx.run(
        INSERT.into(TimesheetHeaders).entries({
          ID: newId,
          employee_ID: employeeId,
          weekStartDate,
          weekEndDate,
          status: 'DRAFT',
          isLocked: isAutoLocked
        })
      );
      header = await tx.run(SELECT.one.from(TimesheetHeaders).where({ ID: newId }));
    } else if (isAutoLocked && !header.isLocked && header.status === 'DRAFT') {
      await tx.run(UPDATE(TimesheetHeaders).set({ isLocked: true }).where({ ID: header.ID }));
      header.isLocked = true;
    }

    header.entries = await tx.run(
      SELECT.from(TimesheetEntries)
        .where({ header_ID: header.ID })
        .columns((e) => {
          e`.*`;
          e.project((p) => p`.*`);
        })
    );

    const assignments = await tx.run(
      SELECT.from(ProjectAssignments)
        .where({
          employee_ID: employeeId,
          validFrom: { '<=': weekEndDate },
          validTo: { '>=': weekStartDate }
        })
        .columns((a) => {
          a`.*`;
          a.project((p) => p`.*`);
        })
    );

    const holidays = await tx.run(
      SELECT.from(PublicHolidays).where({
        holidayDate: { '>=': weekStartDate, '<=': weekEndDate }
      })
    );

    const approvedLeaves = await tx.run(
      SELECT.from(EmployeeLeaves).where({
        employee_ID: employeeId,
        startDate: { '<=': weekEndDate },
        endDate: { '>=': weekStartDate }
      })
    );

    const leaveBalance = await tx.run(
      SELECT.one.from(LeaveBalances).where({ employee_ID: employeeId, year: 2026 })
    );

    return {
      header,
      assignments,
      holidays,
      approvedLeaves,
      leaveBalance,
      compliance: {
        isCutoffPassed: false,
        isAutoLocked: Boolean(header.isLocked),
        officeDaysLogged: header.officeDaysCount || 0,
        officeTargetDays: employee.officeTargetDays || 3
      }
    };
  });

  // =========================================================================
  // FR-01: COPY PREVIOUS WEEK SHORTCUT
  // =========================================================================
  this.on('copyPreviousWeek', async (req) => {
    const tx = cds.tx(req);
    const { employeeId, targetWeekStartDate } = req.data;
    const targetStart = getMonday(targetWeekStartDate);
    const prevStart = addDays(targetStart, -7);

    const prevHeader = await tx.run(
      SELECT.one.from(TimesheetHeaders).where({ employee_ID: employeeId, weekStartDate: prevStart })
    );
    if (!prevHeader) {
      req.reject(404, `No timesheet found for previous week starting ${prevStart}.`);
    }

    const prevEntries = await tx.run(
      SELECT.from(TimesheetEntries).where({ header_ID: prevHeader.ID })
    );
    if (!prevEntries.length) {
      req.reject(400, 'Previous week has no entries to copy.');
    }

    let targetHeader = await tx.run(
      SELECT.one.from(TimesheetHeaders).where({ employee_ID: employeeId, weekStartDate: targetStart })
    );
    if (!targetHeader) {
      const id = cds.utils.uuid();
      await tx.run(
        INSERT.into(TimesheetHeaders).entries({
          ID: id,
          employee_ID: employeeId,
          weekStartDate: targetStart,
          weekEndDate: addDays(targetStart, 6),
          status: 'DRAFT'
        })
      );
      targetHeader = await tx.run(SELECT.one.from(TimesheetHeaders).where({ ID: id }));
    }

    if (targetHeader.status !== 'DRAFT' && targetHeader.status !== 'REJECTED') {
      req.reject(400, `Cannot overwrite a ${targetHeader.status} timesheet.`);
    }

    // Clear existing draft entries
    await tx.run(DELETE.from(TimesheetEntries).where({ header_ID: targetHeader.ID }));

    const holidays = await tx.run(SELECT.from(PublicHolidays).where({ isOptional: false }));
    const holidaySet = new Set(holidays.map((h) => h.holidayDate));

    const leaves = await tx.run(
      SELECT.from(EmployeeLeaves).where({ employee_ID: employeeId, status: 'APPROVED' })
    );

    const isLeaveDate = (d) =>
      leaves.some((l) => d >= l.startDate && d <= l.endDate);

    let copiedCount = 0;
    for (const oldEntry of prevEntries) {
      const offsetDays = Math.round(
        (new Date(oldEntry.workDate + 'T00:00:00Z') - new Date(prevStart + 'T00:00:00Z')) /
          (1000 * 60 * 60 * 24)
      );
      const newDate = addDays(targetStart, offsetDays);

      // Skip dates that are Holidays or Approved Leaves in target week
      if (holidaySet.has(newDate) || isLeaveDate(newDate)) continue;

      await tx.run(
        INSERT.into(TimesheetEntries).entries({
          header_ID: targetHeader.ID,
          project_ID: oldEntry.project_ID,
          workDate: newDate,
          dayOfWeek: oldEntry.dayOfWeek,
          hours: oldEntry.hours,
          workMode: oldEntry.workMode,
          taskCategory: oldEntry.taskCategory,
          remarks: oldEntry.remarks,
          entryStatus: 'DRAFT'
        })
      );
      copiedCount++;
    }

    await recalculateHeader(tx, targetHeader.ID);
    await logAudit(
      tx,
      'TimesheetHeaders',
      targetHeader.ID,
      'COPY_WEEK',
      req.user?.id,
      `Copied ${copiedCount} entries from week ${prevStart} to ${targetStart}`
    );

    return await tx.run(SELECT.one.from(TimesheetHeaders).where({ ID: targetHeader.ID }));
  });

  // =========================================================================
  // FR-02 & FR-03: SUBMIT TIMESHEET (8H/DAY MINIMUM CHECK + BPA ROUTING)
  // =========================================================================
  this.on('submitTimesheet', TimesheetHeaders, async (req) => {
    const tx = cds.tx(req);
    const headerId = req.params[0].ID || req.params[0];
    const header = await tx.run(SELECT.one.from(TimesheetHeaders).where({ ID: headerId }));
    if (!header) req.reject(404, 'Timesheet not found.');
    if (header.isLocked) req.reject(403, 'Timesheet is locked.');

    const entries = await tx.run(SELECT.from(TimesheetEntries).where({ header_ID: headerId }));
    const holidays = await tx.run(SELECT.from(PublicHolidays).where({ isOptional: false }));
    const holidaySet = new Set(holidays.map((h) => h.holidayDate));
    const leaves = await tx.run(
      SELECT.from(EmployeeLeaves).where({ employee_ID: header.employee_ID, status: 'APPROVED' })
    );

    // Validate Monday through Friday (5 working days)
    const missingDays = [];
    for (let i = 0; i < 5; i++) {
      const checkDate = addDays(header.weekStartDate, i);
      const isHoliday = holidaySet.has(checkDate);
      const isLeave = leaves.some((l) => checkDate >= l.startDate && checkDate <= l.endDate);

      if (isHoliday || isLeave) continue;

      const dayHrs = entries
        .filter((e) => e.workDate === checkDate)
        .reduce((sum, e) => sum + Number(e.hours || 0), 0);

      if (dayHrs < 8) {
        missingDays.push(`${checkDate} (${dayHrs}h logged, 8h required)`);
      }
    }

    if (missingDays.length > 0) {
      req.reject(
        400,
        `Submission Blocked: Working days must have at least 8 hours unless covered by Leave/Holiday. Shortfall on: ${missingDays.join('; ')}`
      );
    }

    // Trigger SAP Build Process Automation Workflow (Simulated in local SQLite, REST call in BTP Prod)
    const wfInstanceId = `BPA-WF-${Math.floor(10000 + Math.random() * 90000)}`;

    await tx.run(
      UPDATE(TimesheetHeaders)
        .set({
          status: 'SUBMITTED',
          submittedAt: new Date().toISOString(),
          rejectionReason: null,
          workflowInstanceId: wfInstanceId
        })
        .where({ ID: headerId })
    );
    await tx.run(
      UPDATE(TimesheetEntries).set({ entryStatus: 'SUBMITTED' }).where({ header_ID: headerId })
    );

    await logAudit(
      tx,
      'TimesheetHeaders',
      headerId,
      'SUBMIT',
      req.user?.id,
      `Submitted week ${header.weekStartDate} (${header.totalHours}h). Triggered BPA Workflow ${wfInstanceId}`
    );

    return await tx.run(SELECT.one.from(TimesheetHeaders).where({ ID: headerId }));
  });

  // =========================================================================
  // FR-03 & FR-04: APPROVE, REJECT, BULK APPROVE & AUTO-POST TO S/4HANA CATS
  // =========================================================================
  const executeApprovalAndCatsPost = async (tx, headerId, approver, comments) => {
    const header = await tx.run(SELECT.one.from(TimesheetHeaders).where({ ID: headerId }));
    if (!header) throw new Error(`Header ${headerId} not found`);

    // FR-04: Post Approved Hours to SAP S/4HANA Time Sheet (CATS) API_MANAGE_WORKFORCE_TIMESHEET
    const catsDocId = `CATS-${new Date().getFullYear()}-${Math.floor(100000 + Math.random() * 900000)}`;

    // Increment Project Consumed Hours
    const entries = await tx.run(SELECT.from(TimesheetEntries).where({ header_ID: headerId }));
    for (const entry of entries) {
      if (Number(entry.hours) > 0) {
        await tx.run(
          UPDATE(Projects)
            .set({ consumedHours: { '+=': Number(entry.hours) } })
            .where({ ID: entry.project_ID })
        );
      }
    }

    await tx.run(
      UPDATE(TimesheetHeaders)
        .set({
          status: 'POSTED_CATS',
          approvedBy: approver || 'Ananya Deshmukh',
          approvedAt: new Date().toISOString(),
          catsDocumentId: catsDocId,
          isLocked: true
        })
        .where({ ID: headerId })
    );

    await tx.run(
      UPDATE(TimesheetEntries).set({ entryStatus: 'POSTED_CATS' }).where({ header_ID: headerId })
    );

    await logAudit(
      tx,
      'TimesheetHeaders',
      headerId,
      'APPROVE_AND_CATS_POST',
      approver,
      `Approved (${comments || 'OK'}) and posted to S/4HANA CATS Doc ${catsDocId}`
    );

    return await tx.run(SELECT.one.from(TimesheetHeaders).where({ ID: headerId }));
  };

  this.on('approveTimesheet', TimesheetHeaders, async (req) => {
    const tx = cds.tx(req);
    const headerId = req.params[0].ID || req.params[0];
    return await executeApprovalAndCatsPost(tx, headerId, req.user?.id || 'Ananya Deshmukh', req.data.comments);
  });

  this.on('bulkApproveTimesheets', async (req) => {
    const tx = cds.tx(req);
    const { headerIds, comments } = req.data;
    let count = 0;
    for (const id of headerIds || []) {
      await executeApprovalAndCatsPost(tx, id, req.user?.id || 'Ananya Deshmukh', comments);
      count++;
    }
    return count;
  });

  this.on('rejectTimesheet', TimesheetHeaders, async (req) => {
    const tx = cds.tx(req);
    const headerId = req.params[0].ID || req.params[0];
    const { rejectionReason } = req.data;

    if (!rejectionReason || rejectionReason.trim().length < 5) {
      req.reject(400, 'A mandatory rejection reason (minimum 5 characters) is required.');
    }

    await tx.run(
      UPDATE(TimesheetHeaders)
        .set({
          status: 'REJECTED',
          rejectionReason,
          isLocked: false
        })
        .where({ ID: headerId })
    );
    await tx.run(
      UPDATE(TimesheetEntries)
        .set({ entryStatus: 'REJECTED', rejectionNote: rejectionReason })
        .where({ header_ID: headerId })
    );

    await logAudit(tx, 'TimesheetHeaders', headerId, 'REJECT', req.user?.id, `Rejected: ${rejectionReason}`);
    return await tx.run(SELECT.one.from(TimesheetHeaders).where({ ID: headerId }));
  });

  this.on('unlockTimesheet', TimesheetHeaders, async (req) => {
    const tx = cds.tx(req);
    const headerId = req.params[0].ID || req.params[0];
    await tx.run(UPDATE(TimesheetHeaders).set({ isLocked: false }).where({ ID: headerId }));
    await logAudit(
      tx,
      'TimesheetHeaders',
      headerId,
      'HR_UNLOCK',
      req.user?.id || 'HR Admin',
      `Unlocked by HR: ${req.data.hrRemarks || 'Period reopened'}`
    );
    return await tx.run(SELECT.one.from(TimesheetHeaders).where({ ID: headerId }));
  });

  // =========================================================================
  // LEAVE APPLICATION (SYNC WITH TIMESHEET LOCKING)
  // =========================================================================
  this.on('applyLeave', async (req) => {
    const tx = cds.tx(req);
    const { employeeId, leaveType, startDate, endDate, reason } = req.data;
    if (endDate < startDate) req.reject(400, 'End date cannot be earlier than start date.');

    const daysCount =
      Math.round((new Date(endDate + 'T00:00:00Z') - new Date(startDate + 'T00:00:00Z')) / (1000 * 60 * 60 * 24)) + 1;

    const sfLeaveId = `SF-LV-${Math.floor(10000 + Math.random() * 90000)}`;
    const newLeave = {
      ID: cds.utils.uuid(),
      employee_ID: employeeId,
      leaveType,
      startDate,
      endDate,
      daysCount,
      status: 'APPROVED', // Auto-approved in demo to immediately lock timesheet dates
      sfLeaveId,
      reason
    };

    await tx.run(INSERT.into(EmployeeLeaves).entries(newLeave));
    await logAudit(
      tx,
      'EmployeeLeaves',
      newLeave.ID,
      'APPLY_LEAVE',
      employeeId,
      `Applied & synced ${leaveType} (${startDate} to ${endDate}) - Ref: ${sfLeaveId}`
    );

    return newLeave;
  });

  // =========================================================================
  // FR-05: ANALYTICS & REPORTING DASHBOARD QUERIES
  // =========================================================================
  this.on('getEmployeeMonthlySummary', async (req) => {
    const tx = cds.tx(req);
    const employeeId = req.data.employeeId || 'EMP1001';
    const headers = await tx.run(SELECT.from(TimesheetHeaders).where({ employee_ID: employeeId }));
    const entries = await tx.run(
      SELECT.from(TimesheetEntries).where({
        header_ID: { in: headers.map((h) => h.ID) }
      })
    );
    const leaves = await tx.run(
      SELECT.from(EmployeeLeaves).where({ employee_ID: employeeId, status: 'APPROVED' })
    );

    let totalHours = 0,
      billableHours = 0,
      nonBillableHours = 0,
      overtimeHours = 0;
    headers.forEach((h) => {
      totalHours += Number(h.totalHours || 0);
      billableHours += Number(h.billableHours || 0);
      nonBillableHours += Number(h.nonBillableHours || 0);
      overtimeHours += Number(h.overtimeHours || 0);
    });

    const officeDates = new Set();
    const wfhDates = new Set();
    const clientDates = new Set();

    entries.forEach((e) => {
      if (Number(e.hours) <= 0) return;
      if (e.workMode === 'IN_OFFICE') officeDates.add(e.workDate);
      if (e.workMode === 'WFH') wfhDates.add(e.workDate);
      if (e.workMode === 'CLIENT_SITE') clientDates.add(e.workDate);
    });

    const leaveDaysTaken = leaves.reduce((sum, l) => sum + Number(l.daysCount || 0), 0);
    const totalWorkDays = officeDates.size + wfhDates.size + clientDates.size;
    const officeRatioPct =
      totalWorkDays > 0 ? Math.round(((officeDates.size + clientDates.size) / totalWorkDays) * 100) : 0;

    return {
      totalHours,
      billableHours,
      nonBillableHours,
      overtimeHours,
      inOfficeDays: officeDates.size,
      wfhDays: wfhDates.size,
      clientSiteDays: clientDates.size,
      leaveDaysTaken,
      officeRatioPct
    };
  });

  this.on('getManagerAnalytics', async (req) => {
    const tx = cds.tx(req);
    const headers = await tx.run(SELECT.from(TimesheetHeaders));
    const employees = await tx.run(SELECT.from(Employees));

    let billable = 0,
      nonBillable = 0,
      overtime = 0;
    headers.forEach((h) => {
      billable += Number(h.billableHours || 0);
      nonBillable += Number(h.nonBillableHours || 0);
      overtime += Number(h.overtimeHours || 0);
    });

    const utilizationBreakdown = [
      { category: 'Billable Project Hours', hours: billable },
      { category: 'Non-Billable / Bench Hours', hours: nonBillable },
      { category: 'Overtime Hours', hours: overtime }
    ];

    const currentHeaders = headers.filter((h) => h.weekStartDate === '2026-11-16');
    const officeCompliance = employees
      .filter((e) => e.ID.startsWith('EMP1'))
      .map((emp) => {
        const hdr = currentHeaders.find((h) => h.employee_ID === emp.ID);
        const logged = hdr ? hdr.officeDaysCount : 0;
        return {
          employeeName: emp.fullName,
          officeDays: logged,
          targetDays: emp.officeTargetDays,
          status: logged >= emp.officeTargetDays ? 'Compliant' : 'Below Target'
        };
      });

    const defaulterList = employees
      .filter((e) => e.ID.startsWith('EMP1'))
      .map((emp) => {
        const hdr = currentHeaders.find((h) => h.employee_ID === emp.ID);
        if (!hdr || hdr.status === 'DRAFT' || hdr.status === 'REJECTED') {
          return {
            employeeId: emp.ID,
            employeeName: emp.fullName,
            department: emp.department,
            weekStart: '2026-11-16',
            status: hdr ? hdr.status : 'MISSING',
            daysOverdue: 1
          };
        }
        return null;
      })
      .filter(Boolean);

    return {
      utilizationBreakdown,
      officeCompliance,
      defaulterList
    };
  });
});
