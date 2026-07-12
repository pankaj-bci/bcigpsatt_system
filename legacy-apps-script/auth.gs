// =============================================================================
// FILE: Auth.gs
// PURPOSE: Authentication and role-based access control.
//          All functions prefixed "Auth_"
//
// HOW ADMIN ACCESS WORKS:
//   Any email in the ADMIN sheet = admin.
//   You can add @bcoachindia.com emails AND @gmail.com emails.
//   The script owner's Gmail is auto-added on first run.
// =============================================================================

/**
 * Auth_isAdmin()
 * PURPOSE: Checks if the given email is in the ADMIN sheet.
 * @param  {string}  email
 * @return {boolean} true if admin
 */
function Auth_isAdmin(email) {
  try {
    var data = _execRead(CONFIG.SHEETS.ADMIN);
    for (var i = 1; i < data.length; i++) {
      if (data[i][0] &&
          data[i][0].toString().trim().toLowerCase() === email.trim().toLowerCase()) {
        return true;
      }
    }
    return false;
  } catch(e) {
    Logger.log('Auth_isAdmin ERROR: ' + e.message);
    return false;
  }
}