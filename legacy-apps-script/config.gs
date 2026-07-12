// =============================================================================
// FILE: Config.gs
// PURPOSE: Single source of truth for ALL system settings and policy rules.
//          Change any value here — it applies everywhere automatically.
//          Nothing else in the codebase hardcodes these values.
//
// DEPLOYMENT NOTE:
//   This system is deployed from a personal @gmail.com account so that
//   staff with any Google account (@gmail.com, @any-domain.com) can access it.
//   Admin emails (e.g. @bcoachindia.com) are managed via the ADMIN sheet.
// =============================================================================

var CONFIG = {

  // ---------------------------------------------------------------------------
  // OFFICE LOCATION (Default / Head Office)
  // ⭐ REPLACE with your real office GPS coordinates.
  //
  // HOW TO GET COORDINATES:
  //   1. Open Google Maps on computer
  //   2. Right-click on your office building entrance
  //   3. Click the coordinates shown (e.g. 28.4596, 77.0265)
  //   4. First number = Latitude, Second = Longitude
  //
  // PUNCH OUT RULE: Employee can punch OUT from assigned location OR this office.
  // PUNCH IN RULE:  Employee must punch IN from their ASSIGNED location only.
  // ---------------------------------------------------------------------------
  OFFICE_LOCATION: {
    location_id   : 'L1',
    location_name : 'Head Office',
    latitude      : 28.5374261187015,      // ← REPLACE WITH YOUR OFFICE LATITUDE
    longitude     : 77.2383235529122,      // ← REPLACE WITH YOUR OFFICE LONGITUDE
    radius        : 25          // allowed radius in metres
  },

  // ---------------------------------------------------------------------------
  // DEFAULT SHIFT TIMINGS
  // Applies to all employees unless individually overridden.
  // ---------------------------------------------------------------------------
  SHIFT: {
    START_HOUR   : 9,    // 9:30 AM
    START_MINUTE : 30,
    END_HOUR     : 18,   // 6:30 PM
    END_MINUTE   : 30
  },

  // ---------------------------------------------------------------------------
  // PROBATION EMPLOYEE POLICY
  //
  // Zero tolerance — no free allowances.
  // Punch IN after 9:36 AM  → Half Day (violation)
  // Punch OUT before 6:30 PM → Half Day (violation)
  // Either violation alone = Half Day.
  // Can submit leave form to inform admin (info only, no salary impact).
  // ---------------------------------------------------------------------------
  PROBATION: {
    LATE_THRESHOLD_MINUTES       : 6,    // grace = 6 min after shift start (9:36 AM)
    EARLY_THRESHOLD_MINUTES      : 0,    // no grace before shift end
    EITHER_VIOLATION_IS_HALF_DAY : true
  },

  // ---------------------------------------------------------------------------
  // FIXED EMPLOYEE POLICY
  //
  // PUNCH IN buckets (minutes after 9:30 AM):
  //   ≤ 6 min    → On Time   (≤ 9:36 AM)
  //   6–90 min   → Late      (9:36–11:00 AM)
  //   90min–2PM  → Half Day
  //   after 2PM  → Absent
  //
  // PUNCH OUT buckets:
  //   ≥ 6:30 PM  → On Time
  //   5–6:30 PM  → Early Going
  //   2–5 PM     → Half Day
  //   before 2PM → Absent
  //
  // MONTHLY FREE ALLOWANCES:
  //   3 late/early free — 4th+ each costs 0.5 leave credit
  //   1 leave credit    — 1 full leave OR 2 half days per month
  //
  // ABSENT RULE:
  //   Absent on working day → status = "Absent", deduct 1 credit
  //   No credits left       → status = "Unpaid Absent"
  //
  // LEAVE FORM = information only, does not change salary calculation.
  // ---------------------------------------------------------------------------
  FIXED: {
    ON_TIME_MAX_MINUTES     : 6,    // ≤ 6 min after start = on time
    LATE_MAX_MINUTES        : 90,   // 6–90 min = late
    HALF_DAY_IN_MAX_HOUR    : 14,   // before 2 PM = half day IN
    EARLY_MIN_HOUR          : 17,   // from 5 PM = early going
    EARLY_MIN_MINUTE        : 0,
    HALF_DAY_OUT_MIN_HOUR   : 14,   // 2–5 PM = half day OUT
    HALF_DAY_OUT_MIN_MINUTE : 0,
    MONTHLY_LEAVE_CREDITS   : 1,    // 1 credit = 1 full day OR 2 half days per month
    MONTHLY_LATE_EARLY_FREE : 3     // 3 free late/early per month
  },

  // ---------------------------------------------------------------------------
  // GPS SETTINGS
  // ---------------------------------------------------------------------------
  GPS_MAX_ACCURACY_METERS : 100,   // reject punch if accuracy worse than this
  PUNCH_COOLDOWN_MINUTES  : 2,    // minimum gap between two punches

  // ---------------------------------------------------------------------------
  // WFH / OTHER DISTANCE THRESHOLDS
  // Inverted checks — valid only when the employee is FAR from head office.
  // Unit: metres (matches Loc_haversineDistance return value).
  // ---------------------------------------------------------------------------
  WFH_MIN_DISTANCE_METERS   : 5000,  // WFH valid only if > 5 km from head office
  OTHER_MIN_DISTANCE_METERS : 2000,  // Other valid only if > 2 km from head office

  // ---------------------------------------------------------------------------
  // WEEKLY OFF
  // 0=Sunday, 1=Monday, 2=Tuesday, 3=Wednesday, 4=Thursday, 5=Friday, 6=Saturday
  // Default: Sunday only → [0]
  // Saturday + Sunday   → [0, 6]
  // ---------------------------------------------------------------------------
  WEEKLY_OFF_DAYS: [0],

  // ---------------------------------------------------------------------------
  // LEAVE FORM CONFIG
  // These populate the dropdowns in the leave request form.
  // Leave form is for admin information only — no salary impact.
  // Both Fixed and Probation employees can submit.
  // ---------------------------------------------------------------------------
  LEAVE_APPROVERS : ['AJ Mam', 'RJ Sir'],
  LEAVE_REASONS   : ['Vacation', 'Sick', 'Other'],
  LEAVE_TYPES     : ['Full Day', 'Half Day'],

  // ---------------------------------------------------------------------------
  // GOOGLE DRIVE FOLDER for leave proof screenshot uploads.
  // Leave blank '' to skip file upload (employees describe in text instead).
  //
  // HOW TO GET FOLDER ID:
  //   Create a folder in Google Drive → open it → copy the ID from the URL:
  //   https://drive.google.com/drive/folders/FOLDER_ID_HERE
  // ---------------------------------------------------------------------------
  LEAVE_PROOF_FOLDER_ID: '1b_6SHCzqzIi3UzsAJbcykQlHiR28yLvq',   // ← paste your Google Drive folder ID here

  // ---------------------------------------------------------------------------
  // GOOGLE SHEET TAB NAMES
  // ---------------------------------------------------------------------------
  SHEETS: {
    EMPLOYEES          : 'EMPLOYEES',
    LOCATIONS          : 'LOCATIONS',
    PUNCH_LOGS         : 'PUNCH_LOGS',
    ATTENDANCE_SUMMARY : 'ATTENDANCE_SUMMARY',
    MONTHLY_SUMMARY    : 'MONTHLY_SUMMARY',
    LEAVE_REQUESTS     : 'LEAVE_REQUESTS',
    HOLIDAYS           : 'HOLIDAYS',
    ADMIN              : 'ADMIN'
  },

  // ---------------------------------------------------------------------------
  // ATTENDANCE STATUS LABELS
  // ---------------------------------------------------------------------------
  STATUS: {
    PRESENT         : 'Present',
    ABSENT          : 'Absent',
    UNPAID_ABSENT   : 'Unpaid Absent',
    HALF_DAY        : 'Half Day',
    PUNCH_IN_ONLY   : 'Punch In Only',
    WEEKLY_OFF      : 'Weekly Off',
    HOLIDAY         : 'Holiday',
    WORKING_SUNDAY  : 'Working Sunday',
    WORKING_HOLIDAY : 'Working Holiday',
    ON_TIME         : 'On Time',
    LATE            : 'Late',
    EARLY           : 'Early Going'
  }
};

// ---------------------------------------------------------------------------
// CONFIG HELPERS
// ---------------------------------------------------------------------------

/** Returns shift start as total minutes from midnight (e.g. 9:30 = 570) */
function Config_shiftStartMinutes() {
  return CONFIG.SHIFT.START_HOUR * 60 + CONFIG.SHIFT.START_MINUTE;
}

/** Returns shift end as total minutes from midnight (e.g. 18:30 = 1110) */
function Config_shiftEndMinutes() {
  return CONFIG.SHIFT.END_HOUR * 60 + CONFIG.SHIFT.END_MINUTE;
}

/**
 * Config_isWeeklyOff()
 * @param  {Date} date
 * @return {boolean} true if this day is a weekly off day
 */
function Config_isWeeklyOff(date) {
  return CONFIG.WEEKLY_OFF_DAYS.indexOf(date.getDay()) !== -1;
}