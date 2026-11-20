// The oldest fingers version that receives model catalogs published from this checkout.
// The catalog service keeps one catalog per minimum version; clients older than this keep the
// last catalog published under the previous minimum and stop receiving updates.
//
// Bump this only when generated model metadata requires behavior unavailable in
// older fingers clients, in the same commit as the change that requires it.
export const MINIMUM_FINGERS_VERSION = "0.1.0";
