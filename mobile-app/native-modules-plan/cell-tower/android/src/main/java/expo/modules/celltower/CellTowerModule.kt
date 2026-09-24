package expo.modules.celltower

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.telephony.CellInfo
import android.telephony.CellInfoGsm
import android.telephony.CellInfoLte
import android.telephony.CellInfoNr
import android.telephony.CellInfoWcdma
import android.telephony.CellIdentityNr
import android.telephony.TelephonyManager
import androidx.core.content.ContextCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Reads the phone's serving (registered) cell tower(s) — works with mobile
 * DATA OFF and no internet, because the radio is always registered to a
 * tower for calls/SMS. This is the input RailYatri-style offline tracking
 * uses; the tower -> lat/lng lookup happens in JS against the map the app
 * downloaded for this train's route (src/utils/cellTower.js).
 *
 * Returns: [{ radio, mcc, mnc, area, cid, dbm }]  (registered cells first)
 */
class CellTowerModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("CellTower")

    AsyncFunction("getServingCells") {
      val ctx: Context = appContext.reactContext ?: return@AsyncFunction emptyList<Map<String, Any>>()
      val granted = ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_FINE_LOCATION) ==
        PackageManager.PERMISSION_GRANTED
      if (!granted) return@AsyncFunction emptyList<Map<String, Any>>()
      val tm = ctx.getSystemService(Context.TELEPHONY_SERVICE) as? TelephonyManager
        ?: return@AsyncFunction emptyList<Map<String, Any>>()

      @Suppress("MissingPermission")
      val infos: List<CellInfo> = tm.allCellInfo ?: emptyList()
      infos.sortedByDescending { it.isRegistered }.mapNotNull { toMap(it) }
    }
  }

  private fun toMap(info: CellInfo): Map<String, Any>? {
    return when (info) {
      is CellInfoLte -> {
        val id = info.cellIdentity
        val mcc = id.mccString?.toIntOrNull() ?: return null
        val mnc = id.mncString?.toIntOrNull() ?: return null
        if (id.ci == Int.MAX_VALUE) return null
        mapOf("radio" to "LTE", "mcc" to mcc, "mnc" to mnc, "area" to id.tac, "cid" to id.ci,
              "dbm" to info.cellSignalStrength.dbm, "registered" to info.isRegistered)
      }
      is CellInfoGsm -> {
        val id = info.cellIdentity
        val mcc = id.mccString?.toIntOrNull() ?: return null
        val mnc = id.mncString?.toIntOrNull() ?: return null
        if (id.cid == Int.MAX_VALUE) return null
        mapOf("radio" to "GSM", "mcc" to mcc, "mnc" to mnc, "area" to id.lac, "cid" to id.cid,
              "dbm" to info.cellSignalStrength.dbm, "registered" to info.isRegistered)
      }
      is CellInfoWcdma -> {
        val id = info.cellIdentity
        val mcc = id.mccString?.toIntOrNull() ?: return null
        val mnc = id.mncString?.toIntOrNull() ?: return null
        if (id.cid == Int.MAX_VALUE) return null
        mapOf("radio" to "UMTS", "mcc" to mcc, "mnc" to mnc, "area" to id.lac, "cid" to id.cid,
              "dbm" to info.cellSignalStrength.dbm, "registered" to info.isRegistered)
      }
      else -> {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && info is CellInfoNr) {
          val id = info.cellIdentity as CellIdentityNr
          val mcc = id.mccString?.toIntOrNull() ?: return null
          val mnc = id.mncString?.toIntOrNull() ?: return null
          // NCI is a 36-bit Long — kept as Double for the JS bridge.
          mapOf("radio" to "NR", "mcc" to mcc, "mnc" to mnc, "area" to id.tac, "cid" to id.nci.toDouble(),
                "dbm" to info.cellSignalStrength.dbm, "registered" to info.isRegistered)
        } else null
      }
    }
  }
}
