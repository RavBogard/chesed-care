// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const flagAction = vi.hoisted(() => vi.fn());
vi.mock("@/app/v/actions", () => ({ flagAction }));

import { FlagForm } from "@/components/volunteers/flag-form";

afterEach(() => {
  cleanup();
  flagAction.mockReset();
});

const send = (text: string) => {
  fireEvent.change(screen.getByLabelText("What a rabbi should know"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
};

describe("the box on the volunteer's page", () => {
  it("once sent, says only that it was sent: no Inbox, no id, and the box is gone", async () => {
    flagAction.mockResolvedValue({ status: "sent" });
    const { container } = render(<FlagForm token="tok" stamp="1.sig" />);
    expect(screen.getByText("Something a rabbi should know")).toBeTruthy();
    send("I think I am in over my head.");
    await waitFor(() => expect(screen.getByTestId("flag-sent").textContent).toBe("Sent. A rabbi will see it."));
    expect(container.textContent).toBe("Sent. A rabbi will see it.");
    expect(container.querySelector("textarea")).toBeNull();
    const sent = flagAction.mock.calls[0][1] as FormData;
    expect(sent.get("token")).toBe("tok");
    expect(sent.get("stamp")).toBe("1.sig");
    expect(sent.get("words")).toBe("I think I am in over my head.");
  });

  it("after a refusal, shows the calm sentence and keeps what was written", async () => {
    flagAction.mockResolvedValue({ status: "error", message: "That was a lot of tries from one place. Please wait a little while and try again." });
    render(<FlagForm token="tok" stamp="1.sig" />);
    send("Something is not right.");
    await waitFor(() => expect(screen.getByText("That was a lot of tries from one place. Please wait a little while and try again.")).toBeTruthy());
    expect((screen.getByLabelText("What a rabbi should know") as HTMLTextAreaElement).value).toBe("Something is not right.");
  });
});
