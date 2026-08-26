import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GatewayEnrollmentPanel } from "./GatewayEnrollmentPanel";

const request = {
  enrollmentId: "enrollment-1",
  gatewayNodeId: "gateway-node-1",
  gatewayName: "Office Gateway",
  verificationCode: "123-456",
  requestedAt: 1_800_000_000_000,
  expiresAt: 1_800_000_600_000,
};

function render(approvedEnrollmentIds: ReadonlySet<string>): string {
  return renderToStaticMarkup(createElement(GatewayEnrollmentPanel, {
    invitation: null,
    pending: [request],
    approvedEnrollmentIds,
    busy: false,
    error: null,
    onCreate() {},
    onApprove() {},
    onClear() {},
  }));
}

describe("GatewayEnrollmentPanel", () => {
  it("offers approval while a Gateway request is pending", () => {
    const html = render(new Set());

    expect(html).toContain("2. Approve Office Gateway");
    expect(html).toContain("Approve Gateway");
    expect(html).toContain("123-456");
  });

  it("keeps an approved Gateway visible with a safe resend action", () => {
    const html = render(new Set([request.enrollmentId]));

    expect(html).toContain("Approved Office Gateway");
    expect(html).toContain("Waiting for this Gateway to finish setup");
    expect(html).toContain("Send approval again");
  });
});
