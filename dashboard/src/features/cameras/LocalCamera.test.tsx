// @vitest-environment jsdom
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderAs } from "../../test/render";
import CamerasPage from "./CamerasPage";
import { cam, fakeRegistry } from "./fakeApi";

vi.setConfig({ testTimeout: 20_000 });
vi.mock("./map", () => ({ RegistryMap: () => <div>map</div>, MiniMap: () => <div>mini map</div>, LocationPickerMap: () => <div>picker</div> }));

function fakeWebcam() {
  const stop = vi.fn();
  const track = { stop, label: "Integrated Webcam", getSettings: () => ({ deviceId: "dev-1" }) };
  const getUserMedia = vi.fn(async () => ({ getTracks: () => [track], getVideoTracks: () => [track] }));
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia,
      enumerateDevices: async () => [{ kind: "videoinput", deviceId: "dev-1", label: "", groupId: "" }],
      addEventListener: () => {}, removeEventListener: () => {},
    },
  });
  return { getUserMedia, stop };
}

afterEach(() => {
  Reflect.deleteProperty(navigator, "mediaDevices");
});

describe("this computer's camera in Cities & Cameras", () => {
  it("is shown while the registry is empty, and asks for video only", async () => {
    const { getUserMedia, stop } = fakeWebcam();
    const user = userEvent.setup({ delay: null });
    renderAs("admin", <CamerasPage api={fakeRegistry({ listCameras: vi.fn(async () => []) })} />);
    expect(await screen.findByTestId("local-camera")).toBeInTheDocument();
    expect(await screen.findByText(/1 camera detected on this PC/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Preview/ }));
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledWith(expect.objectContaining({ audio: false })));
    await user.click(await screen.findByRole("button", { name: "Stop and close" }));
    await waitFor(() => expect(stop).toHaveBeenCalled()); // camera light goes off
  });

  it("disappears once a real camera is registered", async () => {
    fakeWebcam();
    renderAs("admin", <CamerasPage api={fakeRegistry({ listCameras: vi.fn(async () => [cam()]) })} />);
    expect(await screen.findByText("Agdal gate 1")).toBeInTheDocument();
    expect(screen.queryByTestId("local-camera")).toBeNull();
  });

  it("says so honestly when the browser has no camera access", async () => {
    renderAs("admin", <CamerasPage api={fakeRegistry({ listCameras: vi.fn(async () => []) })} />);
    expect(await screen.findByText(/cannot use a camera here/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Preview/ })).toBeDisabled();
  });
});
