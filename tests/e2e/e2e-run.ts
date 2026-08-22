import {
  e2eAdminUsername as adminUsername,
  e2eAdminUserId as adminUserId,
  e2eCreatedUsernames,
  e2eDiningTableName as diningTableName,
  e2eReservationFirstName as reservationFirstName,
  e2eRestaurantId as restaurantId,
  e2eStaffUsername as staffUsername,
  parseE2eRunId,
} from "../../scripts/e2e-fixture-ownership";

export const e2eRunId = parseE2eRunId(process.env.E2E_RUN_ID);
export const e2eRestaurantId = restaurantId(e2eRunId);
export const e2eAdminUsername = adminUsername(e2eRunId);
export const e2eAdminUserId = adminUserId(e2eRunId);
export const e2eStaffUsername = staffUsername(e2eRunId);
export const e2eReservationFirstName = reservationFirstName(e2eRunId);
export const e2eDiningTableName = diningTableName(e2eRunId);
export const [e2eAuditMustChangeUsername, e2eCreatedStaffUsername, e2eResetStaffUsername] =
  e2eCreatedUsernames(e2eRunId);
