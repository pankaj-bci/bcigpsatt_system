// =============================================================================
// FILE: Database.gs
// PURPOSE: ALL Google Sheets read/write operations live here.
//          This is the DATA LAYER. Nothing else in the system touches
//          SpreadsheetApp directly — everything goes through these functions.
//
// NAMING CONVENTION: All functions prefixed "DB_"
//
// SHEETS MANAGED:
//   EMPLOYEES          → employee records
//   LOCATIONS          → GPS location records
//   PUNCH_LOGS         → raw punch IN/OUT records
//   ATTENDANCE_SUMMARY → daily computed attendance status
//   MONTHLY_SUMMARY    → monthly rollup per employee
//   LEAVE_REQUESTS     → leave form submissions (info only)
//   HOLIDAYS           → public holiday list for the year
//   ADMIN              → admin email list
// =============================================================================


// =============================================================================
// CORE SHEET UTILITIES
// =============================================================================

/**
 * DB_getSpreadsheet()
 * PURPOSE: Returns the active Google Spreadsheet. Starting point for all ops.
 * @return {Spreadsheet}
 */
function DB_getSpreadsheet() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

/**
 * DB_getOrCreateSheet()
 * PURPOSE: Gets a sheet by name. Creates it if it doesn't exist yet.
 *          Safe to call at any time — never crashes if sheet is missing.
 * @param  {string} name - Sheet tab name
 * @return {Sheet}
 */
function DB_getOrCreateSheet(name) {
  var ss    = DB_getSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    Logger.log('DB_getOrCreateSheet: Created new sheet → ' + name);
  }
  return sheet;
}


// =============================================================================
// CACHE LAYER  (Phase 2 — speed boost)
// =============================================================================
//
// Apps Script's CacheService stores small JSON blobs in Google's memory layer.
// Reading from cache: ~30 ms.  Reading from a sheet: 800–2000 ms.
// We use cache ONLY for shared, slow-changing data — employees, locations,
// holidays — and invalidate it on every write so admin changes show up
// immediately. Cache failure is always silent — we fall back to direct sheet
// reads so production stays safe even if Google's cache is unavailable.
//
// Cache keys are versioned ("_v1") so we can force-invalidate everywhere by
// bumping the version, e.g. after deploying a code change that alters the row
// schema. Never reuse a key name with a different shape — always bump version.

var _CACHE_KEYS = {
  EMPLOYEES : 'db_all_employees_v1',
  LOCATIONS : 'db_all_locations_v1',
  HOLIDAYS  : 'db_holiday_list_v1'
};
var _CACHE_TTL_SHORT = 300;   // 5  min — employees can change (admin adds new staff)
var _CACHE_TTL_LONG  = 1800;  // 30 min — locations + holidays rarely change

/**
 * _cacheGet()  [PRIVATE]
 *   Reads a JSON value from CacheService. Returns null on miss OR any error.
 */
function _cacheGet(key) {
  try {
    var raw = CacheService.getScriptCache().get(key);
    return raw ? JSON.parse(raw) : null;
  } catch(e) {
    Logger.log('_cacheGet(' + key + ') error: ' + e.message);
    return null;
  }
}

/**
 * _cachePut()  [PRIVATE]
 *   Stores a JSON value into CacheService. Failures are swallowed silently —
 *   the system continues to work normally without caching.
 */
function _cachePut(key, value, ttlSeconds) {
  try {
    CacheService.getScriptCache().put(key, JSON.stringify(value), ttlSeconds);
  } catch(e) {
    Logger.log('_cachePut(' + key + ') error: ' + e.message);
  }
}

/**
 * _cacheInvalidate()  [PRIVATE]
 *   Removes a cache entry. Called from every write function so the next
 *   read fetches fresh data from the sheet.
 */
function _cacheInvalidate(key) {
  try {
    CacheService.getScriptCache().remove(key);
  } catch(e) {
    Logger.log('_cacheInvalidate(' + key + ') error: ' + e.message);
  }
}

// ── Per-execution in-memory cache ──────────────────────────────────────────
// GAS creates a fresh JS context for every request, so _execCache resets
// automatically between requests — no TTL, no cross-request leakage.
// Benefit: each sheet is read at most once per GAS call regardless of how
// many DB functions touch it (e.g. 70-employee backfill = 1 read, not 70).
// Write functions call _execInvalidate so subsequent reads see fresh data.
var _execCache = {};

function _execRead(sheetName) {
  if (!_execCache[sheetName]) {
    _execCache[sheetName] = DB_getOrCreateSheet(sheetName).getDataRange().getValues();
  }
  return _execCache[sheetName];
}

function _execInvalidate(sheetName) {
  delete _execCache[sheetName];
}

/**
 * initializeDatabase()
 * PURPOSE: Creates all required sheet tabs with correct headers on first run.
 *          Called from doGet() in Code.gs on every app load.
 *          Safe to call repeatedly — only acts on empty sheets.
 */
function initializeDatabase() {
  var S = CONFIG.SHEETS;

  // Create each sheet with its headers if it doesn't exist yet
  _initSheet(S.EMPLOYEES, [
    'emp_id', 'name', 'email', 'employee_type',
    'assigned_location_id', 'shift_start_time', 'status'
  ]);
  _initSheet(S.LOCATIONS, [
    'location_id', 'location_name', 'latitude', 'longitude', 'radius'
  ]);
  _initSheet(S.PUNCH_LOGS, [
    'log_id', 'emp_id', 'action', 'datetime', 'latitude', 'longitude',
    'locationType', 'locationName'
  ]);
  _initSheet(S.ATTENDANCE_SUMMARY, [
    'emp_id', 'date', 'in_time', 'out_time', 'status',
    'late_flag', 'early_flag', 'half_day_flag', 'working_sunday',
    'leave_credit_used', 'notes'
  ]);
  _initSheet(S.MONTHLY_SUMMARY, [
    'emp_id', 'month', 'working_days', 'total_present',
    'total_late', 'total_early', 'total_half_days',
    'total_absent', 'total_unpaid_absent', 'total_leaves_used',
    'total_working_sundays', 'late_early_used', 'leave_credits_used'
  ]);
  _initSheet(S.LEAVE_REQUESTS, [
    'request_id', 'emp_id', 'name', 'leave_from', 'leave_to',
    'request_type', 'reason', 'approved_by', 'proof_link',
    'status', 'timestamp', 'admin_note'
  ]);
  _initSheet(S.HOLIDAYS, [
    'date', 'holiday_name'
  ]);
  _initSheet(S.ADMIN, ['email']);

  // Migrate existing PUNCH_LOGS: add locationType + locationName headers if not present
  // Runs on every doGet() but is a no-op once the headers exist (fast column check).
  var plSheet   = DB_getOrCreateSheet(S.PUNCH_LOGS);
  var plLastCol = plSheet.getLastColumn();
  if (plSheet.getLastRow() >= 1 && plLastCol < 8) {
    if (plLastCol < 7) {
      plSheet.getRange(1, 7).setValue('locationType')
        .setFontWeight('bold').setBackground('#1a73e8').setFontColor('#ffffff');
    }
    plSheet.getRange(1, 8).setValue('locationName')
      .setFontWeight('bold').setBackground('#1a73e8').setFontColor('#ffffff');
    Logger.log('initializeDatabase: Migrated PUNCH_LOGS — added locationType/locationName headers.');
  }

  // Seed default office location from CONFIG if LOCATIONS is empty
  var locSheet = DB_getOrCreateSheet(S.LOCATIONS);
  if (locSheet.getLastRow() <= 1) {
    var o = CONFIG.OFFICE_LOCATION;
    locSheet.appendRow([o.location_id, o.location_name, o.latitude, o.longitude, o.radius]);
    Logger.log('initializeDatabase: Seeded default office location L1.');
  }

  // Auto-add script owner as first admin if ADMIN sheet is fresh
  var adminSheet = DB_getOrCreateSheet(S.ADMIN);
  if (adminSheet.getLastRow() <= 1) {
    var owner = Session.getEffectiveUser().getEmail();
    if (owner) {
      adminSheet.appendRow([owner]);
      Logger.log('initializeDatabase: Added owner as admin → ' + owner);
    }
  }
}

/**
 * _initSheet()  [PRIVATE]
 * PURPOSE: Creates header row with formatting for a sheet if it is empty.
 * @param {string} name    - Sheet name
 * @param {Array}  headers - Array of column header strings
 */
function _initSheet(name, headers) {
  var sheet = DB_getOrCreateSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
    sheet.getRange(1, 1, 1, headers.length)
      .setFontWeight('bold')
      .setBackground('#1a73e8')
      .setFontColor('#ffffff');
  }
}


// =============================================================================
// EMPLOYEE OPERATIONS
// =============================================================================

/**
 * DB_getEmployeeByEmail()
 * PURPOSE: Find employee record by their Google email address.
 *          Used on login to verify the user is registered.
 * @param  {string}      email
 * @return {Object|null} employee object or null if not found
 */
function DB_getEmployeeByEmail(email) {
  // Guard: email must be a non-empty string
  if (!email || typeof email !== 'string' || email.trim().length === 0) {
    Logger.log('DB_getEmployeeByEmail: Called with empty/undefined email — returning null');
    return null;
  }
  // Route through cached list — same result, ~25x faster on cache hit
  var needle = email.trim().toLowerCase();
  var list   = DB_getAllEmployees();
  for (var i = 0; i < list.length; i++) {
    if (list[i].email && list[i].email.toLowerCase() === needle) return list[i];
  }
  return null;
}

/**
 * DB_getEmployeeById()
 * PURPOSE: Find employee record by their emp_id.
 * @param  {string}      empId
 * @return {Object|null}
 */
function DB_getEmployeeById(empId) {
  if (!empId && empId !== 0) return null;
  var needle = _normalizeEmpId(empId);
  var list   = DB_getAllEmployees();
  for (var i = 0; i < list.length; i++) {
    if (list[i].emp_id === needle) return list[i];
  }
  return null;
}

/**
 * DB_getAllEmployees()
 * PURPOSE: Returns all employee records as an array of objects.
 *          [Cached — 5 min TTL] Sheet is only read on cache miss or after a
 *          write (which invalidates the cache key).
 * @return {Array<Object>}
 */
function DB_getAllEmployees() {
  // Try cache first
  var cached = _cacheGet(_CACHE_KEYS.EMPLOYEES);
  if (cached) return cached;

  // Cache miss — read from sheet
  var data = DB_getOrCreateSheet(CONFIG.SHEETS.EMPLOYEES).getDataRange().getValues();
  var out  = [];
  for (var i = 1; i < data.length; i++) {
    if (data[i][0]) out.push(_rowToEmployee(data[i]));
  }

  // Store for next call
  _cachePut(_CACHE_KEYS.EMPLOYEES, out, _CACHE_TTL_SHORT);
  return out;
}

/**
 * DB_saveEmployee()
 * PURPOSE: Appends a new employee row. Validates no duplicate emp_id or email.
 * @param  {Object} d - { emp_id, name, email, employee_type, assigned_location_id, shift_start_time, status }
 * @return {Object} { success, message }
 */
function DB_saveEmployee(d) {
  if (DB_getEmployeeByEmail(d.email)) {
    return { success: false, message: 'Email "' + d.email + '" is already registered.' };
  }
  if (DB_getEmployeeById(d.emp_id)) {
    return { success: false, message: 'Employee ID "' + d.emp_id + '" is already in use.' };
  }
  DB_getOrCreateSheet(CONFIG.SHEETS.EMPLOYEES).appendRow([
    d.emp_id.trim(),
    d.name.trim(),
    d.email.trim(),
    d.employee_type        || 'Fixed',
    d.assigned_location_id.trim(),
    d.shift_start_time     || '09:30',
    d.status               || 'Active'
  ]);
  _cacheInvalidate(_CACHE_KEYS.EMPLOYEES); // fresh data on next read
  Logger.log('DB_saveEmployee: Added → ' + d.emp_id + ' / ' + d.email);
  return { success: true, message: 'Employee "' + d.name + '" added successfully.' };
}

/**
 * DB_updateEmployee()
 * PURPOSE: Updates one or more fields on an existing employee row.
 *          Caller passes only the fields they want to change.
 * @param  {string} empId
 * @param  {Object} updates - key/value pairs matching column names
 * @return {Object} { success, message }
 */
function DB_updateEmployee(empId, updates) {
  var sheet = DB_getOrCreateSheet(CONFIG.SHEETS.EMPLOYEES);
  var data  = sheet.getDataRange().getValues();
  // Column index map (0-based)
  var cols  = {
    emp_id: 0, name: 1, email: 2,
    employee_type: 3, assigned_location_id: 4,
    shift_start_time: 5, status: 6
  };
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] && data[i][0].toString().trim() === empId.toString().trim()) {
      for (var key in updates) {
        if (cols[key] !== undefined) {
          sheet.getRange(i + 1, cols[key] + 1).setValue(updates[key]);
        }
      }
      _cacheInvalidate(_CACHE_KEYS.EMPLOYEES); // fresh data on next read
      Logger.log('DB_updateEmployee: Updated ' + empId + ' → ' + JSON.stringify(updates));
      return { success: true, message: 'Employee ' + empId + ' updated.' };
    }
  }
  return { success: false, message: 'Employee ID "' + empId + '" not found.' };
}

/**
 * _rowToEmployee()  [PRIVATE]
 * PURPOSE: Converts a raw sheet data row array into a named employee object.
 * @param  {Array}  row
 * @return {Object}
 */
function _normalizeEmpId(id) {
  if (!id && id !== 0) return '';
  var s = id.toString().trim();
  while (s.length < 4) s = '0' + s;
  return s;
}

function _rowToEmployee(row) {
  return {
    emp_id               : _normalizeEmpId(row[0]),
    name                 : row[1] ? row[1].toString().trim() : '',
    email                : row[2] ? row[2].toString().trim() : '',
    employee_type        : row[3] ? row[3].toString().trim() : 'Fixed',
    assigned_location_id : row[4] ? row[4].toString().trim() : '',
    shift_start_time     : row[5] ? row[5].toString().trim() : '09:30',
    status               : row[6] ? row[6].toString().trim() : 'Active'
  };
}


// =============================================================================
// LOCATION OPERATIONS
// =============================================================================

/**
 * DB_getLocationById()
 * PURPOSE: Get one location record by its location_id.
 * @param  {string}      locationId - e.g. "L2"
 * @return {Object|null}
 */
function DB_getLocationById(locationId) {
  if (!locationId) return null;
  // Route through cached list — same result, ~25x faster on cache hit
  var needle = locationId.toString().trim();
  var list   = DB_getAllLocations();
  for (var i = 0; i < list.length; i++) {
    if (list[i].location_id === needle) return list[i];
  }
  return null;
}

/**
 * DB_getAllLocations()
 * PURPOSE: Returns all location records. Used in admin dropdowns and tables
 *          AND on every staff dashboard load.
 *          [Cached — 30 min TTL] Locations change rarely.
 * @return {Array<Object>}
 */
function DB_getAllLocations() {
  // Try cache first
  var cached = _cacheGet(_CACHE_KEYS.LOCATIONS);
  if (cached) return cached;

  // Cache miss — read from sheet
  var data = DB_getOrCreateSheet(CONFIG.SHEETS.LOCATIONS).getDataRange().getValues();
  var out  = [];
  for (var i = 1; i < data.length; i++) {
    if (data[i][0]) out.push(_rowToLocation(data[i]));
  }

  _cachePut(_CACHE_KEYS.LOCATIONS, out, _CACHE_TTL_LONG);
  return out;
}

/**
 * DB_getOfficeLocation()
 * PURPOSE: Returns the default office location.
 *          First tries sheet (in case admin updated coordinates),
 *          falls back to CONFIG values.
 * @return {Object}
 */
function DB_getOfficeLocation() {
  return DB_getLocationById(CONFIG.OFFICE_LOCATION.location_id) || CONFIG.OFFICE_LOCATION;
}

/**
 * DB_saveLocation()
 * PURPOSE: Appends a new location row. Checks for duplicate location_id.
 * @param  {Object} d - { location_id, location_name, latitude, longitude, radius }
 * @return {Object} { success, message }
 */
function DB_saveLocation(d) {
  if (DB_getLocationById(d.location_id)) {
    return { success: false, message: 'Location ID "' + d.location_id + '" already exists.' };
  }
  DB_getOrCreateSheet(CONFIG.SHEETS.LOCATIONS).appendRow([
    d.location_id.trim(),
    d.location_name.trim(),
    parseFloat(d.latitude),
    parseFloat(d.longitude),
    parseFloat(d.radius) || 100
  ]);
  _cacheInvalidate(_CACHE_KEYS.LOCATIONS); // fresh data on next read
  return { success: true, message: 'Location "' + d.location_name + '" added.' };
}

/**
 * _rowToLocation()  [PRIVATE]
 * @param  {Array}  row
 * @return {Object}
 */
function _rowToLocation(row) {
  return {
    location_id   : row[0] ? row[0].toString().trim() : '',
    location_name : row[1] ? row[1].toString().trim() : '',
    latitude      : parseFloat(row[2]) || 0,
    longitude     : parseFloat(row[3]) || 0,
    radius        : parseFloat(row[4]) || 100
  };
}


// =============================================================================
// PUNCH LOG OPERATIONS
// =============================================================================

/**
 * DB_savePunchLog()
 * PURPOSE: Writes one punch record to PUNCH_LOGS sheet.
 *          Called only after ALL validations have passed.
 * @param {string} empId
 * @param {string} action       - "IN" or "OUT"
 * @param {number} latitude
 * @param {number} longitude
 * @param {string} locationType - "HEAD_OFFICE" | "WORKSHOP" | "WFH" | "OTHER"
 * @param {string} locationName - human-readable name, e.g. "Head Office"
 */
function DB_savePunchLog(empId, action, latitude, longitude, locationType, locationName) {
  var sheet = DB_getOrCreateSheet(CONFIG.SHEETS.PUNCH_LOGS);
  var logId = sheet.getLastRow();
  var tz    = Session.getScriptTimeZone();
  var now   = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm:ss');
  sheet.appendRow([logId, empId, action, now, latitude, longitude,
                   locationType || '', locationName || '']);
  _execInvalidate(CONFIG.SHEETS.PUNCH_LOGS); // day evaluation must see the new punch
  Logger.log('DB_savePunchLog: ' + empId + ' → ' + action + ' @ ' + now + ' [' + (locationType||'') + ']');
}

/**
 * DB_getLastPunchLog()
 * PURPOSE: Returns the single most recent punch for an employee.
 *          Used for anti-fraud checks (cooldown + duplicate action).
 * @param  {string}      empId
 * @return {Object|null}
 */
function DB_getLastPunchLog(empId) {
  var data = _execRead(CONFIG.SHEETS.PUNCH_LOGS);
  var last = null;
  for (var i = 1; i < data.length; i++) {
    if (data[i][1] && data[i][1].toString().trim() === empId) {
      last = _rowToPunchLog(data[i]);
    }
  }
  return last;
}

/**
 * DB_getPunchLogsForDate()
 * PURPOSE: Returns all punch logs for a specific employee on a specific date.
 *          Used by PolicyEngine to evaluate a single day.
 *
 * FIX: Google Sheets sometimes returns datetime cells as JavaScript Date objects
 *      instead of strings. When .toString() is called on a Date object, it gives
 *      "Mon Apr 28 2026 12:21:23 GMT+0530" which does NOT start with "2026-04-28".
 *      Fix: use Utilities.formatDate() to normalise Date objects to "yyyy-MM-dd HH:mm:ss".
 *
 * @param  {string} empId
 * @param  {string} dateStr - "yyyy-MM-dd"
 * @return {Array<Object>}
 */
function DB_getPunchLogsForDate(empId, dateStr) {
  var data = _execRead(CONFIG.SHEETS.PUNCH_LOGS);
  var tz   = Session.getScriptTimeZone();
  var out   = [];

  for (var i = 1; i < data.length; i++) {
    if (!data[i][1]) continue;
    if (data[i][1].toString().trim() !== empId) continue;

    var rawDt = data[i][3];
    var dtStr = '';

    // Handle both Date objects and plain strings
    if (rawDt instanceof Date) {
      dtStr = Utilities.formatDate(rawDt, tz, 'yyyy-MM-dd HH:mm:ss');
    } else {
      dtStr = rawDt ? rawDt.toString().trim() : '';
    }

    // Match rows where the date portion equals dateStr
    if (dtStr.indexOf(dateStr) === 0) {
      out.push(_rowToPunchLog(data[i]));
    }
  }
  return out;
}

/**
 * DB_getAllPunchLogs()
 * PURPOSE: Returns all punch logs, newest first. Used in admin panel.
 * @return {Array<Object>}
 */
function DB_getAllPunchLogs() {
  var data = _execRead(CONFIG.SHEETS.PUNCH_LOGS);
  var out  = [];
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] !== '') out.push(_rowToPunchLog(data[i]));
  }
  return out.reverse();
}

/**
 * DB_getPunchLogsForAllToday()
 * PURPOSE: Returns ALL employees' punch logs for TODAY only.
 *          Much faster than DB_getAllPunchLogs() — scans the sheet once but
 *          only keeps today's rows (typically 40-80 rows vs thousands).
 *          Used by the admin "Today" dashboard and the Punch Logs tab.
 * @return {Array<Object>} newest first
 */
function DB_getPunchLogsForAllToday() {
  var tz    = Session.getScriptTimeZone();
  var today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  var data  = _execRead(CONFIG.SHEETS.PUNCH_LOGS);
  var out     = [];

  for (var i = 1; i < data.length; i++) {
    if (!data[i][1]) continue;

    var rawDt = data[i][3];
    var dtStr = (rawDt instanceof Date)
      ? Utilities.formatDate(rawDt, tz, 'yyyy-MM-dd HH:mm:ss')
      : (rawDt ? rawDt.toString().trim() : '');

    if (dtStr.indexOf(today) === 0) {
      out.push(_rowToPunchLog(data[i]));
    }
  }
  return out.reverse(); // newest first
}

/**
 * _rowToPunchLog()  [PRIVATE]
 * @param  {Array}  row
 * @return {Object}
 */
function _rowToPunchLog(row) {
  // FIX: Google Sheets may return datetime as a Date object.
  // Normalise to "yyyy-MM-dd HH:mm:ss" string using Utilities.formatDate.
  var tz  = Session.getScriptTimeZone();
  var raw = row[3];
  var dt  = '';
  if (raw instanceof Date) {
    dt = Utilities.formatDate(raw, tz, 'yyyy-MM-dd HH:mm:ss');
  } else {
    dt = raw ? raw.toString().trim() : '';
  }
  return {
    log_id       : row[0],
    emp_id       : _normalizeEmpId(row[1]),
    action       : row[2] ? row[2].toString().trim() : '',
    datetime     : dt,
    latitude     : row[4],
    longitude    : row[5],
    locationType : row[6] ? row[6].toString().trim() : '',
    locationName : row[7] ? row[7].toString().trim() : ''
  };
}


// =============================================================================
// HOLIDAY OPERATIONS  ← NEW
// =============================================================================

/**
 * DB_getHolidayList()
 * PURPOSE: Returns all holidays as an array of { date, holiday_name } objects.
 *          date is stored as "yyyy-MM-dd" string in the sheet.
 * @return {Array<Object>}
 */
function DB_getHolidayList() {
  // Try cache first
  var cached = _cacheGet(_CACHE_KEYS.HOLIDAYS);
  if (cached) return cached;

  // Cache miss — read from sheet
  var sheet = DB_getOrCreateSheet(CONFIG.SHEETS.HOLIDAYS);
  var data  = sheet.getDataRange().getValues();
  var out   = [];
  var tz    = Session.getScriptTimeZone();

  for (var i = 1; i < data.length; i++) {
    if (!data[i][0]) continue;

    // Date may be stored as a Date object or a string — normalise to string
    var rawDate = data[i][0];
    var dateStr = '';
    if (rawDate instanceof Date) {
      dateStr = Utilities.formatDate(rawDate, tz, 'yyyy-MM-dd');
    } else {
      dateStr = rawDate.toString().trim();
    }

    out.push({
      date         : dateStr,
      holiday_name : data[i][1] ? data[i][1].toString().trim() : ''
    });
  }

  _cachePut(_CACHE_KEYS.HOLIDAYS, out, _CACHE_TTL_LONG);
  return out;
}

/**
 * DB_isHoliday()
 * PURPOSE: Checks if a specific date is a public holiday.
 *          Accepts a pre-loaded holidayList array to avoid repeated sheet reads
 *          when processing many days in a loop.
 *
 * @param  {string}        dateStr     - "yyyy-MM-dd"
 * @param  {Array<Object>} holidayList - from DB_getHolidayList()
 * @return {Object|null}   holiday object if found, null if not a holiday
 */
function DB_isHoliday(dateStr, holidayList) {
  // Guard: holidayList may be undefined if HOLIDAYS sheet is empty or not yet created
  if (!holidayList || !Array.isArray(holidayList)) return null;
  for (var i = 0; i < holidayList.length; i++) {
    if (holidayList[i].date === dateStr) return holidayList[i];
  }
  return null;
}

/**
 * DB_saveHoliday()
 * PURPOSE: Adds a new holiday to the HOLIDAYS sheet.
 *          Admin uses this from the Admin Dashboard.
 * @param  {string} dateStr      - "yyyy-MM-dd"
 * @param  {string} holidayName
 * @return {Object} { success, message }
 */
function DB_saveHoliday(dateStr, holidayName) {
  if (!dateStr || !holidayName) {
    return { success: false, message: 'Date and holiday name are required.' };
  }

  // Check for duplicate date
  var existing = DB_getHolidayList();
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].date === dateStr) {
      return { success: false, message: 'Holiday on ' + dateStr + ' already exists: "' + existing[i].holiday_name + '".' };
    }
  }

  var sheet = DB_getOrCreateSheet(CONFIG.SHEETS.HOLIDAYS);
  sheet.appendRow([dateStr, holidayName.trim()]);
  _cacheInvalidate(_CACHE_KEYS.HOLIDAYS); // fresh data on next read
  Logger.log('DB_saveHoliday: Added → ' + dateStr + ' / ' + holidayName);
  return { success: true, message: 'Holiday "' + holidayName + '" added for ' + dateStr + '.' };
}

/**
 * DB_deleteHoliday()
 * PURPOSE: Removes a holiday by date. Admin can correct mistakes.
 * @param  {string} dateStr - "yyyy-MM-dd"
 * @return {Object} { success, message }
 */
function DB_deleteHoliday(dateStr) {
  var sheet = DB_getOrCreateSheet(CONFIG.SHEETS.HOLIDAYS);
  var data  = sheet.getDataRange().getValues();
  var tz    = Session.getScriptTimeZone();

  for (var i = 1; i < data.length; i++) {
    var rawDate = data[i][0];
    var d = rawDate instanceof Date
      ? Utilities.formatDate(rawDate, tz, 'yyyy-MM-dd')
      : rawDate.toString().trim();

    if (d === dateStr) {
      sheet.deleteRow(i + 1);
      _cacheInvalidate(_CACHE_KEYS.HOLIDAYS); // fresh data on next read
      return { success: true, message: 'Holiday on ' + dateStr + ' deleted.' };
    }
  }
  return { success: false, message: 'No holiday found for date: ' + dateStr };
}


// =============================================================================
// ATTENDANCE SUMMARY OPERATIONS
// =============================================================================

/**
 * DB_saveAttendanceSummary()
 * PURPOSE: Writes or UPDATES a daily attendance summary row.
 *          If a row already exists for this emp_id + date, it is overwritten.
 *          This allows re-processing a day after leave approval or correction.
 * @param {Object} d - attendance summary object
 */
function DB_saveAttendanceSummary(d) {
  var sheet = DB_getOrCreateSheet(CONFIG.SHEETS.ATTENDANCE_SUMMARY);
  var data  = _execRead(CONFIG.SHEETS.ATTENDANCE_SUMMARY);

  // Check if a row already exists for this employee + date
  // FIX: date column may be a Date object — normalise before comparing
  var tz = Session.getScriptTimeZone();
  for (var i = 1; i < data.length; i++) {
    var rowEmp  = data[i][0] ? data[i][0].toString().trim() : '';
    var rawDate = data[i][1];
    var rowDate = '';
    if (rawDate instanceof Date) {
      rowDate = Utilities.formatDate(rawDate, tz, 'yyyy-MM-dd');
    } else {
      rowDate = rawDate ? rawDate.toString().trim() : '';
    }
    if (rowEmp === d.emp_id && rowDate === d.date) {
      // Update existing row in place
      sheet.getRange(i + 1, 1, 1, 11).setValues([[
        d.emp_id,
        d.date,
        d.in_time          || '',
        d.out_time         || '',
        d.status           || '',
        d.late_flag        || false,
        d.early_flag       || false,
        d.half_day_flag    || false,
        d.working_sunday   || false,
        d.leave_credit_used|| 0,
        d.notes            || ''
      ]]);
      _execInvalidate(CONFIG.SHEETS.ATTENDANCE_SUMMARY);
      return;
    }
  }

  // No existing row — append new
  sheet.appendRow([
    d.emp_id, d.date,
    d.in_time || '', d.out_time || '', d.status || '',
    d.late_flag || false, d.early_flag || false,
    d.half_day_flag || false, d.working_sunday || false,
    d.leave_credit_used || 0, d.notes || ''
  ]);
  _execInvalidate(CONFIG.SHEETS.ATTENDANCE_SUMMARY);
}

/**
 * DB_batchAppendAttendanceSummary()
 * PURPOSE: Writes multiple attendance rows in ONE Sheets API call.
 *          Used by Attendance_backfillMissingDays to avoid N individual
 *          writes (one per missing day) which each cost ~1 second.
 *          Skips any row whose (emp_id, date) already exists — safe against
 *          rare race conditions where two requests backfill the same employee.
 * @param {Array<Object>} rows - array of attendance summary objects
 */
function DB_batchAppendAttendanceSummary(rows) {
  if (!rows || rows.length === 0) return;
  var sheet    = DB_getOrCreateSheet(CONFIG.SHEETS.ATTENDANCE_SUMMARY);
  var existing = _execRead(CONFIG.SHEETS.ATTENDANCE_SUMMARY);
  var tz       = Session.getScriptTimeZone();

  // Build existence map from cached data
  var seen = {};
  for (var i = 1; i < existing.length; i++) {
    var emp  = existing[i][0] ? existing[i][0].toString().trim() : '';
    var rawD = existing[i][1];
    var dt   = rawD instanceof Date
      ? Utilities.formatDate(rawD, tz, 'yyyy-MM-dd')
      : (rawD ? rawD.toString().trim() : '');
    if (emp && dt) seen[emp + '|' + dt] = true;
  }

  var toWrite = [];
  rows.forEach(function(d) {
    if (seen[d.emp_id + '|' + d.date]) return; // already exists — skip
    toWrite.push([
      d.emp_id, d.date,
      d.in_time || '', d.out_time || '', d.status || '',
      d.late_flag || false, d.early_flag || false,
      d.half_day_flag || false, d.working_sunday || false,
      d.leave_credit_used || 0, d.notes || ''
    ]);
  });

  if (toWrite.length > 0) {
    var startRow = sheet.getLastRow() + 1;
    sheet.getRange(startRow, 1, toWrite.length, 11).setValues(toWrite);
  }
  _execInvalidate(CONFIG.SHEETS.ATTENDANCE_SUMMARY);
}

/**
 * DB_getAttendanceSummaryForEmployee()
 * PURPOSE: Returns all daily summary rows for one employee,
 *          optionally filtered by month string "yyyy-MM".
 * @param  {string} empId
 * @param  {string} monthStr - optional "yyyy-MM"
 * @return {Array<Object>}
 */
function DB_getAttendanceSummaryForEmployee(empId, monthStr) {
  var data = _execRead(CONFIG.SHEETS.ATTENDANCE_SUMMARY);
  var out  = [];
  for (var i = 1; i < data.length; i++) {
    if (!data[i][0]) continue;
    if (data[i][0].toString().trim() !== empId) continue;
    // FIX: date column may be Date object
    var rawD = data[i][1];
    var dStr = rawD instanceof Date
      ? Utilities.formatDate(rawD, Session.getScriptTimeZone(), 'yyyy-MM-dd')
      : (rawD ? rawD.toString().trim() : '');
    if (monthStr && dStr.indexOf(monthStr) !== 0) continue;
    out.push(_rowToAttSummary(data[i]));
  }
  return out;
}

/**
 * DB_getAttendanceSummaryAll()
 * PURPOSE: Returns daily summaries for admin, with optional filters.
 * @param  {string} empId    - optional
 * @param  {string} monthStr - optional "yyyy-MM"
 * @return {Array<Object>}
 */
function DB_getAttendanceSummaryAll(empId, monthStr) {
  var data = _execRead(CONFIG.SHEETS.ATTENDANCE_SUMMARY);
  var out  = [];
  var tzA = Session.getScriptTimeZone();
  for (var i = 1; i < data.length; i++) {
    if (!data[i][0]) continue;
    var rowEmpX = data[i][0].toString().trim();
    var rawDX   = data[i][1];
    var rowDX   = rawDX instanceof Date
      ? Utilities.formatDate(rawDX, tzA, 'yyyy-MM-dd')
      : (rawDX ? rawDX.toString().trim() : '');
    if (empId    && rowEmpX !== empId)              continue;
    if (monthStr && rowDX.indexOf(monthStr) !== 0)  continue;
    out.push(_rowToAttSummary(data[i]));
  }
  return out.reverse();
}

/**
 * _rowToAttSummary()  [PRIVATE]
 * @param  {Array}  row
 * @return {Object}
 */
function _rowToAttSummary(row) {
  // FIX: date, in_time, out_time may be Date objects — normalise all to strings
  var tz = Session.getScriptTimeZone();

  function _toDateStr(v) {
    if (!v) return '';
    if (v instanceof Date) return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
    return v.toString().trim();
  }
  function _toTimeStr(v) {
    if (!v) return '';
    if (v instanceof Date) return Utilities.formatDate(v, tz, 'HH:mm:ss');
    return v.toString().trim();
  }

  return {
    emp_id           : _normalizeEmpId(row[0]),
    date             : _toDateStr(row[1]),
    in_time          : _toTimeStr(row[2]),
    out_time         : _toTimeStr(row[3]),
    status           : row[4]  ? row[4].toString()         : '',
    late_flag        : row[5]  === true || row[5] === 'TRUE',
    early_flag       : row[6]  === true || row[6] === 'TRUE',
    half_day_flag    : row[7]  === true || row[7] === 'TRUE',
    working_sunday   : row[8]  === true || row[8] === 'TRUE',
    leave_credit_used: Number(row[9])  || 0,
    notes            : row[10] ? row[10].toString()        : ''
  };
}


// =============================================================================
// MONTHLY SUMMARY OPERATIONS
// =============================================================================

/**
 * DB_saveMonthlySummary()
 * PURPOSE: Writes or UPDATES the monthly rollup for one employee.
 * @param {Object} d - monthly summary object
 */
function DB_saveMonthlySummary(d) {
  var sheet = DB_getOrCreateSheet(CONFIG.SHEETS.MONTHLY_SUMMARY);
  var data  = _execRead(CONFIG.SHEETS.MONTHLY_SUMMARY);

  var tz2 = Session.getScriptTimeZone();
  for (var i = 1; i < data.length; i++) {
    var rowEmpM  = data[i][0] ? data[i][0].toString().trim() : '';
    var rawMonth = data[i][1];
    var rowMonth = rawMonth instanceof Date
      ? Utilities.formatDate(rawMonth, tz2, 'yyyy-MM')
      : (rawMonth ? rawMonth.toString().trim() : '');
    if (rowEmpM === d.emp_id && rowMonth === d.month) {
      sheet.getRange(i + 1, 1, 1, 13).setValues([[
        d.emp_id, d.month,
        d.working_days         || 0,
        d.total_present        || 0,
        d.total_late           || 0,
        d.total_early          || 0,
        d.total_half_days      || 0,
        d.total_absent         || 0,
        d.total_unpaid_absent  || 0,
        d.total_leaves_used    || 0,
        d.total_working_sundays|| 0,
        d.late_early_used      || 0,
        d.leave_credits_used   || 0
      ]]);
      _execInvalidate(CONFIG.SHEETS.MONTHLY_SUMMARY);
      return;
    }
  }

  sheet.appendRow([
    d.emp_id, d.month,
    d.working_days || 0, d.total_present || 0, d.total_late || 0,
    d.total_early || 0, d.total_half_days || 0, d.total_absent || 0,
    d.total_unpaid_absent || 0, d.total_leaves_used || 0,
    d.total_working_sundays || 0, d.late_early_used || 0,
    d.leave_credits_used || 0
  ]);
  _execInvalidate(CONFIG.SHEETS.MONTHLY_SUMMARY);
}

/**
 * DB_getMonthlySummary()
 * @param  {string}      empId
 * @param  {string}      monthStr - "yyyy-MM"
 * @return {Object|null}
 */
function DB_getMonthlySummary(empId, monthStr) {
  var data = _execRead(CONFIG.SHEETS.MONTHLY_SUMMARY);
  var tz3 = Session.getScriptTimeZone();
  for (var i = 1; i < data.length; i++) {
    var rowEmpG  = data[i][0] ? data[i][0].toString().trim() : '';
    var rawMonG  = data[i][1];
    var rowMonG  = rawMonG instanceof Date
      ? Utilities.formatDate(rawMonG, tz3, 'yyyy-MM')
      : (rawMonG ? rawMonG.toString().trim() : '');
    if (rowEmpG === empId && rowMonG === monthStr) {
      return _rowToMonthlySummary(data[i]);
    }
  }
  return null;
}

/**
 * DB_getAllMonthlySummaries()
 * @param  {string} empId    - optional filter
 * @param  {string} monthStr - optional filter
 * @return {Array<Object>}
 */
function DB_getAllMonthlySummaries(empId, monthStr) {
  var data = _execRead(CONFIG.SHEETS.MONTHLY_SUMMARY);
  var out  = [];
  for (var i = 1; i < data.length; i++) {
    if (!data[i][0]) continue;
    var rowEmpA = data[i][0] ? data[i][0].toString().trim() : '';
    var rawMonA = data[i][1];
    var rowMonA = rawMonA instanceof Date
      ? Utilities.formatDate(rawMonA, Session.getScriptTimeZone(), 'yyyy-MM')
      : (rawMonA ? rawMonA.toString().trim() : '');
    if (empId    && rowEmpA !== empId)    continue;
    if (monthStr && rowMonA !== monthStr) continue;
    out.push(_rowToMonthlySummary(data[i]));
  }
  return out;
}

/**
 * _rowToMonthlySummary()  [PRIVATE]
 * @param  {Array}  row
 * @return {Object}
 */
function _rowToMonthlySummary(row) {
  // FIX: month column may come back as a Date object from Google Sheets
  var tz  = Session.getScriptTimeZone();
  var raw = row[1];
  var mon = raw instanceof Date
    ? Utilities.formatDate(raw, tz, 'yyyy-MM')
    : (raw ? raw.toString().trim() : '');
  return {
    emp_id               : _normalizeEmpId(row[0]),
    month                : mon,
    working_days         : Number(row[2])  || 0,
    total_present        : Number(row[3])  || 0,
    total_late           : Number(row[4])  || 0,
    total_early          : Number(row[5])  || 0,
    total_half_days      : Number(row[6])  || 0,
    total_absent         : Number(row[7])  || 0,
    total_unpaid_absent  : Number(row[8])  || 0,
    total_leaves_used    : Number(row[9])  || 0,
    total_working_sundays: Number(row[10]) || 0,
    late_early_used      : Number(row[11]) || 0,
    leave_credits_used   : Number(row[12]) || 0
  };
}


// =============================================================================
// LEAVE REQUEST OPERATIONS
// =============================================================================

/**
 * DB_saveLeaveRequest()
 * PURPOSE: Appends a new leave request row. Auto-generates request_id.
 *          NOTE: Leave form is INFORMATION ONLY — does not affect salary.
 *          Both Fixed and Probation employees can submit.
 * @param  {Object} d
 * @return {Object} { success, message, request_id }
 */
function DB_saveLeaveRequest(d) {
  var sheet     = DB_getOrCreateSheet(CONFIG.SHEETS.LEAVE_REQUESTS);
  var requestId = 'LR' + Date.now();
  var tz        = Session.getScriptTimeZone();
  var ts        = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm:ss');

  sheet.appendRow([
    requestId, d.emp_id, d.name, d.leave_from, d.leave_to,
    d.request_type, d.reason, d.approved_by,
    d.proof_link || '', 'Pending', ts, ''
  ]);

  Logger.log('DB_saveLeaveRequest: ' + requestId + ' by ' + d.emp_id);
  return { success: true, message: 'Leave request submitted.', request_id: requestId };
}

/**
 * DB_updateLeaveStatus()
 * PURPOSE: Admin marks a leave request as Approved or Rejected.
 * @param  {string} requestId
 * @param  {string} status    - 'Approved' | 'Rejected'
 * @param  {string} adminNote - optional note
 * @return {Object} { success, message }
 */
function DB_updateLeaveStatus(requestId, status, adminNote) {
  var sheet = DB_getOrCreateSheet(CONFIG.SHEETS.LEAVE_REQUESTS);
  var data  = _execRead(CONFIG.SHEETS.LEAVE_REQUESTS);
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] && data[i][0].toString() === requestId) {
      sheet.getRange(i + 1, 10).setValue(status);
      sheet.getRange(i + 1, 12).setValue(adminNote || '');
      _execInvalidate(CONFIG.SHEETS.LEAVE_REQUESTS);
      return { success: true, message: 'Leave request ' + status + '.' };
    }
  }
  return { success: false, message: 'Request ID "' + requestId + '" not found.' };
}

/**
 * DB_getLeaveRequestsForEmployee()
 * @param  {string} empId
 * @return {Array<Object>}
 */
function DB_getLeaveRequestsForEmployee(empId) {
  var data = _execRead(CONFIG.SHEETS.LEAVE_REQUESTS);
  var out  = [];
  for (var i = 1; i < data.length; i++) {
    if (data[i][1] && data[i][1].toString().trim() === empId) {
      out.push(_rowToLeaveRequest(data[i]));
    }
  }
  return out.reverse();
}

/**
 * DB_getAllLeaveRequests()
 * @param  {string} empId        - optional filter
 * @param  {string} statusFilter - optional 'Pending'|'Approved'|'Rejected'
 * @return {Array<Object>}
 */
function DB_getAllLeaveRequests(empId, statusFilter) {
  var data = _execRead(CONFIG.SHEETS.LEAVE_REQUESTS);
  var out  = [];
  for (var i = 1; i < data.length; i++) {
    if (!data[i][0]) continue;
    if (empId        && data[i][1].toString().trim() !== empId)        continue;
    if (statusFilter && data[i][9].toString().trim() !== statusFilter) continue;
    out.push(_rowToLeaveRequest(data[i]));
  }
  return out.reverse();
}

/**
 * DB_getLeaveRequestsForToday()
 * PURPOSE: Returns leave requests where TODAY falls within the leave_from..leave_to
 *          range (i.e. the leave covers today). Used by the admin "Today" dashboard
 *          ("On Leave" tile) and the default Leave Requests tab view.
 *
 *          Optionally filter by status (e.g. only "Approved" + "Pending").
 *
 * @param  {Array<string>} [statuses] - optional list of statuses to include
 * @return {Array<Object>}
 */
function DB_getLeaveRequestsForToday(statuses) {
  var tz    = Session.getScriptTimeZone();
  var today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  var all   = DB_getAllLeaveRequests(null, null);
  var out   = [];

  for (var i = 0; i < all.length; i++) {
    var r = all[i];
    // today must be between leave_from and leave_to (inclusive, string compare works for yyyy-MM-dd)
    if (r.leave_from && r.leave_to &&
        today >= r.leave_from && today <= r.leave_to) {
      if (!statuses || statuses.indexOf(r.status) !== -1) {
        out.push(r);
      }
    }
  }
  return out;
}

/**
 * _rowToLeaveRequest()  [PRIVATE]
 * @param  {Array}  row
 * @return {Object}
 */
function _rowToLeaveRequest(row) {
  // FIX: leave_from and leave_to may come back as Date objects from Google Sheets
  // Use the same normalisation pattern as _rowToAttSummary and _rowToMonthlySummary
  var tz = Session.getScriptTimeZone();
  function _toDateStr(v) {
    if (!v) return '';
    if (v instanceof Date) return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
    return v.toString().trim();
  }
  return {
    request_id   : row[0]  ? row[0].toString()        : '',
    emp_id       : _normalizeEmpId(row[1]),
    name         : row[2]  ? row[2].toString()         : '',
    leave_from   : _toDateStr(row[3]),
    leave_to     : _toDateStr(row[4]),
    request_type : row[5]  ? row[5].toString()         : '',
    reason       : row[6]  ? row[6].toString()         : '',
    approved_by  : row[7]  ? row[7].toString()         : '',
    proof_link   : row[8]  ? row[8].toString()         : '',
    status       : row[9]  ? row[9].toString()         : '',
    timestamp    : row[10] ? row[10].toString()        : '',
    admin_note   : row[11] ? row[11].toString()        : ''
  };
}