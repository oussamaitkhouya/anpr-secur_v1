// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 20_000 });
import { renderAs } from "../../test/render";
import { CameraWizard } from "./CameraWizard";
import { cam, CITY, fakeRegistry } from "./fakeApi";
import { MASK } from "./logic";

// Leaflet needs a real layout engine; the map itself is not what these tests are about.
vi.mock("./map", () => ({
  LocationPickerMap: ({ onPick }: { onPick: (a: number, b: number) => void }) => (
    <button type="button" onClick={() => onPick(34.020882, -6.84165)}>Pick on map</button>
  ),
}));

const SECRET_USER = "cam-operator-CANARY";
const SECRET_PASS = "Pw-CANARY-4f9e!x";

function setup(camera?: ReturnType<typeof cam>) {
  const api = fakeRegistry();
  const onClose = vi.fn();
  const user = userEvent.setup({ delay: null });
  renderAs("admin", <CameraWizard open onClose={onClose} cities={[CITY]} camera={camera} api={api} onSaved={() => {}} />);
  return { api, user, onClose };
}

const next = () => screen.getByRole("button", { name: /^Next:/ });

async function fillToCredentials(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Camera name"), "Agdal gate 9");
  await user.click(screen.getByLabelText(/ANPR camera/));
  await user.click(next());
  await user.click(await screen.findByRole("button", { name: "Pick on map" }));
  await user.click(next());
  await user.type(await screen.findByLabelText("Host"), "10.20.0.12");
  await user.type(screen.getByLabelText("Stream path"), "/stream1");
  await user.click(next());
  await screen.findByLabelText("Camera username");
}

describe("CameraWizard", () => {
  it("blocks Next and shows inline errors while a step is invalid", async () => {
    const { user } = setup();
    await user.click(next());
    expect(await screen.findByText("Give the camera a name.")).toBeInTheDocument();
    expect(screen.getByText("Choose the camera type.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Identity/ })).toHaveAttribute("aria-current", "step");
  });

  it("refuses credentials in the host field", async () => {
    const { user } = setup();
    await user.type(screen.getByLabelText("Camera name"), "x");
    await user.click(screen.getByLabelText(/PTZ/));
    await user.click(next());
    await user.click(await screen.findByRole("button", { name: "Pick on map" }));
    await user.click(next());
    await user.type(await screen.findByLabelText("Host"), "admin:pw@10.0.0.5");
    await user.click(next());
    expect(await screen.findByText(/Never put credentials in the host/)).toBeInTheDocument();
  });

  it("masks credentials in the URL preview and never renders typed credentials back", async () => {
    const { user } = setup();
    await fillToCredentials(user);
    await user.type(screen.getByLabelText("Camera username"), SECRET_USER);
    await user.type(screen.getByLabelText("Camera password"), SECRET_PASS);
    expect(screen.getByLabelText("Camera password")).toHaveAttribute("type", "password");
    await user.click(next()); // Review
    await screen.findByRole("region", { name: "Review" });
    const preview = screen.getByTestId("url-preview");
    expect(preview).toHaveTextContent(`rtsps://${MASK}:${MASK}@10.20.0.12:322/stream1`);
    expect(document.body.textContent).not.toContain(SECRET_PASS);
    expect(document.body.textContent).not.toContain(SECRET_USER);
    expect(document.body.innerHTML).not.toContain(SECRET_PASS);
  });

  it("sends credentials only to the write-only endpoint, never in the camera body", async () => {
    const { user, api } = setup();
    await fillToCredentials(user);
    await user.type(screen.getByLabelText("Camera username"), SECRET_USER);
    await user.type(screen.getByLabelText("Camera password"), SECRET_PASS);
    await user.click(next());
    await user.click(await screen.findByRole("button", { name: /Add camera/ }));
    await waitFor(() => expect(api.replaceCredentials).toHaveBeenCalledWith("cam-new", { username: SECRET_USER, password: SECRET_PASS }));
    expect(JSON.stringify(vi.mocked(api.createCamera).mock.calls)).not.toContain(SECRET_PASS);
    // shown twice on purpose: the success check in the drawer and the toast
    expect(await screen.findAllByText("Camera added")).toHaveLength(2);
    expect(document.body.innerHTML).not.toContain(SECRET_PASS);
  });

  it("runs the connection test with an honest verdict", async () => {
    const { user, api } = setup();
    await fillToCredentials(user);
    await user.click(next());
    await user.click(await screen.findByRole("button", { name: /Test connection/ }));
    await waitFor(() => expect(api.testDraftConnection).toHaveBeenCalledWith({ protocol: "rtsps", host: "10.20.0.12", port: null }));
    expect(await screen.findByText(/Network reachable, stream not verified/)).toBeInTheDocument();
  });

  it("when editing, shows 'Credentials set' with a Replace action and no prefilled secret fields", async () => {
    const { user } = setup(cam({ credentialsSet: true }));
    for (let i = 0; i < 3; i++) await user.click(next());
    const region = await screen.findByRole("region", { name: "Credentials" });
    expect(within(region).getByText("Credentials set")).toBeInTheDocument();
    expect(within(region).queryByLabelText("Camera password")).toBeNull();
    await user.click(within(region).getByRole("button", { name: /Replace credentials/ }));
    expect(within(region).getByLabelText("Camera password")).toHaveValue("");
    expect(within(region).getByLabelText("Camera username")).toHaveValue("");
  });

  it("asks before discarding unsaved changes on Escape", async () => {
    const { user, onClose } = setup();
    await user.type(screen.getByLabelText("Camera name"), "half-typed");
    await user.keyboard("{Escape}");
    expect(await screen.findByText("Discard your changes?")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
