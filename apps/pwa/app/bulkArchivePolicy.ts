export function bulkArchiveEligible(status: string, protectedRepair: boolean, lifecycleBusy: boolean): boolean {
  return status !== "running" && status !== "stopping" && status !== "archived" &&
    !protectedRepair && !lifecycleBusy;
}
