// @vitest-environment jsdom
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/errors";
import { Guard } from "../../app/RouteViews";
import { renderAs } from "../../test/render";
import CamerasPage from "./CamerasPage";
import { cam, CITY, fakeRegistry } from "./fakeApi";
import { ImportDialog } from "./ImportDialog";

vi.setConfig({ testTimeout: 20_000 });
vi.mock("./map", () => ({ RegistryMap: () => <div>map</div>, MiniMap: () => <div>mini map</div>, LocationPickerMap: () => <div>picker</div> }));

describe("Cities & Cameras page: RBAC states", () => {
  it("admin gets the management actions", async () => {
    renderAs("admin", <CamerasPage api={fakeRegistry()} />);
    expect(await screen.findByText("Agdal gate 1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Add camera/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Import CSV/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Actions for Agdal gate 1" })).toBeInTheDocument();
  });

  it("analyst gets a read-only view: no add, import, row actions or bulk select", async () => {
    renderAs("analyst", <CamerasPage api={fakeRegistry()} />);
    expect(await screen.findByText("Agdal gate 1")).toBeInTheDocument();
    expect(screen.getByText(/You can view cameras in your assigned cities/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add camera/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Import CSV/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Actions for/ })).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add city" })).toBeNull();
  });

  it("auditor is refused by the route guard before any request", async () => {
    const api = fakeRegistry();
    renderAs("auditor", <Guard permission="registry:view" what="Cities & Cameras"><CamerasPage api={api} /></Guard>);
    expect(screen.getByText("Access denied")).toBeInTheDocument();
    expect(api.listCameras).not.toHaveBeenCalled();
  });

  it("shows Access denied when the API says 403, even if the UI let the user in", async () => {
    const api = fakeRegistry({ listCameras: vi.fn(async () => { throw new ApiError(403, "Your role does not allow this."); }) });
    renderAs("admin", <CamerasPage api={api} />);
    expect(await screen.findByText("Access denied")).toBeInTheDocument();
  });
});

describe("Cities & Cameras page: API error states", () => {
  it("shows the server message and retries", async () => {
    let fail = true;
    const api = fakeRegistry({
      listCameras: vi.fn(async () => {
        if (fail) throw new ApiError(0, "Cannot reach the API at http://localhost:8000. Is it running?");
        return [cam()];
      }),
    });
    renderAs("admin", <CamerasPage api={api} />);
    expect(await screen.findByText(/Cannot reach the API/)).toBeInTheDocument();
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: /Try again/ }));
    expect(await screen.findByText("Agdal gate 1")).toBeInTheDocument();
  });

  it("explains a refused delete instead of failing silently", async () => {
    const api = fakeRegistry({ deleteCity: vi.fn(async () => { throw new ApiError(409, "The city still has 1 camera(s); move or delete them first."); }) });
    const user = userEvent.setup({ delay: null });
    renderAs("admin", <CamerasPage api={api} />);
    await user.click(await screen.findByRole("button", { name: `Delete ${CITY.name}` }));
    await user.click(screen.getByRole("button", { name: "Delete city" }));
    expect(await screen.findByText(/still has 1 camera/)).toBeInTheDocument();
  });

  it("never renders a credential value, only whether one is set", async () => {
    renderAs("admin", <CamerasPage api={fakeRegistry()} />);
    expect(await screen.findByText("Credentials set")).toBeInTheDocument();
    expect(document.body.innerHTML).not.toMatch(/password|credentialsEncrypted/i);
  });
});

describe("CSV import dialog", () => {
  it("previews accepted and rejected rows with reasons, then confirms", async () => {
    const api = fakeRegistry();
    const onImported = vi.fn();
    const user = userEvent.setup({ delay: null });
    renderAs("admin", <ImportDialog open onClose={() => {}} api={api} cities={[CITY]} onImported={onImported} />);
    const file = new File(["city,name\nRabat,x\n"], "cams.csv", { type: "text/csv" });
    await user.upload(screen.getByLabelText("CSV file"), file);
    const preview = await screen.findByTestId("import-preview");
    expect(preview).toHaveTextContent("1 accepted");
    expect(preview).toHaveTextContent("1 rejected");
    expect(preview).toHaveTextContent("Imported cam");
    expect(preview).toHaveTextContent("latitude: Input should be less than or equal to 90");
    expect(api.importCsv).toHaveBeenCalledWith(file, "preview");
    await user.click(screen.getByRole("button", { name: "Import 1 camera" }));
    await waitFor(() => expect(api.importCsv).toHaveBeenCalledWith(file, "confirm"));
    expect(onImported).toHaveBeenCalled();
  });

  it("refuses non-CSV files before sending anything", async () => {
    const api = fakeRegistry();
    const user = userEvent.setup({ delay: null, applyAccept: false });
    renderAs("admin", <ImportDialog open onClose={() => {}} api={api} cities={[CITY]} onImported={() => {}} />);
    await user.upload(screen.getByLabelText("CSV file"), new File(["x"], "cams.xlsx"));
    expect(await screen.findByText("Choose a .csv file.")).toBeInTheDocument();
    expect(api.importCsv).not.toHaveBeenCalled();
  });
});
