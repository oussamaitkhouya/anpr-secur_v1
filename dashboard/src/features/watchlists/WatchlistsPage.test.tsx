// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderAs } from "../../test/render";
import WatchlistsPage from "./WatchlistsPage";

vi.setConfig({ testTimeout: 20_000 });

const LIST = { id: "wl-1", name: "Stolen vehicles", source: "DGSN", createdAt: "2026-10-01T00:00:00Z", activeEntries: 1 };
const ENTRY = {
  id: "e-1", listId: "wl-1", importId: null, plateCanonical: "12345|أ|6", reason: "stolen", color: "white", make: null, model: null,
  vehicleType: null, caseRef: "CASE-1", source: "DGSN", addedAt: new Date().toISOString(), expiresAt: null, removedAt: null, status: "active",
};

function stub(lists: unknown[], entries: unknown[] = []) {
  const posts: { url: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      posts.push({ url, body });
      return new Response(JSON.stringify({ ...ENTRY, id: "e-2", plateCanonical: body.plate }), { status: 201 });
    }
    const out = url.endsWith("/watchlists") ? lists : url.includes("/imports") ? [] : entries;
    return new Response(JSON.stringify(out), { status: 200 });
  }));
  return posts;
}

afterEach(() => vi.unstubAllGlobals());

describe("Watchlists page (real API)", () => {
  it("invites creating a list when there is none", async () => {
    stub([]);
    renderAs("admin", <WatchlistsPage />);
    expect(await screen.findByText("No watchlist yet")).toBeInTheDocument();
  });

  it("shows the entries of the selected list", async () => {
    stub([LIST], [ENTRY]);
    renderAs("admin", <WatchlistsPage />);
    expect(await screen.findByText("CASE-1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove 12345|أ|6" })).toBeInTheDocument();
  });

  it("validates the plate and sends the canonical form", async () => {
    const posts = stub([LIST], [ENTRY]);
    const user = userEvent.setup({ delay: null });
    renderAs("admin", <WatchlistsPage />);
    await user.click(await screen.findByRole("button", { name: /Add plate/ }));
    await user.type(screen.getByLabelText("Plate"), "ABC");
    expect(screen.getByText(/Not a valid Moroccan plate yet/)).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "Add plate" }).at(-1)!);
    expect(posts).toHaveLength(0);
    await user.clear(screen.getByLabelText("Plate"));
    await user.type(screen.getByLabelText("Plate"), "777-ب-1");
    await user.click(screen.getAllByRole("button", { name: "Add plate" }).at(-1)!);
    await waitFor(() => expect(posts[0]?.body).toMatchObject({ plate: "777|ب|1", reason: "stolen" }));
  });

  it("shows each list as a card and summarises the selected list by reason", async () => {
    const WANTED = { ...ENTRY, id: "e-3", plateCanonical: "777|ب|1", reason: "wanted", caseRef: "CASE-2" };
    stub([LIST, { ...LIST, id: "wl-2", name: "Wanted vehicles", activeEntries: 0 }], [ENTRY, WANTED]);
    renderAs("admin", <WatchlistsPage />);
    const cards = await screen.findByRole("group", { name: "Watchlists" });
    expect(within(cards).getByRole("button", { name: /Stolen vehicles/, pressed: true })).toBeInTheDocument();
    expect(within(cards).getByRole("button", { name: /Wanted vehicles/, pressed: false })).toBeInTheDocument();
    expect(await screen.findByRole("img", { name: "Active plates by reason: Stolen 1, Wanted 1, Other 0" })).toBeInTheDocument();
  });

  it("flags an entry that expires within a week", async () => {
    const soon = new Date(Date.now() + 2 * 86_400_000).toISOString();
    stub([LIST], [{ ...ENTRY, expiresAt: soon }]);
    renderAs("admin", <WatchlistsPage />);
    const summary = await screen.findByRole("region", { name: "Stolen vehicles summary" });
    await waitFor(() => expect(summary.textContent).toMatch(/Expiring 7 d\s*1/));
    expect(screen.getByText("in 2 days")).toBeInTheDocument();
  });

  it("shows plates as a wall that flips to details, highlights search hits, and remembers the table view", async () => {
    localStorage.clear();
    stub([LIST], [ENTRY]);
    const user = userEvent.setup({ delay: null });
    const { unmount } = renderAs("admin", <WatchlistsPage />);
    const wall = await screen.findByRole("list", { name: "Plate wall" });
    expect(within(wall).getByLabelText("Plate 12345 أ 6")).toBeInTheDocument();

    // the details side is inert until the card is flipped
    const remove = screen.getByRole("button", { name: "Remove 12345|أ|6" });
    expect(remove.closest("[inert]")).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Details of 12345|أ|6" }));
    expect(remove.closest("[inert]")).toBeNull();

    await user.type(screen.getByRole("textbox"), "234");
    expect(wall.querySelector("mark")?.textContent).toBe("234");

    await user.click(screen.getByRole("tab", { name: /Table/ }));
    expect(screen.queryByRole("list", { name: "Plate wall" })).toBeNull();
    expect(screen.getByRole("table")).toBeInTheDocument();
    unmount();
    renderAs("admin", <WatchlistsPage />);
    expect(await screen.findByRole("table")).toBeInTheDocument();
    localStorage.clear();
  });

  it("puts plates that stop alerting within 30 days on the expiry radar", async () => {
    const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
    stub([LIST], [
      { ...ENTRY, expiresAt: inDays(3) },
      { ...ENTRY, id: "e-4", plateCanonical: "555|د|33", expiresAt: inDays(20) },
      { ...ENTRY, id: "e-5", plateCanonical: "777|ب|1", expiresAt: inDays(90) },
    ]);
    renderAs("admin", <WatchlistsPage />);
    const radar = await screen.findByRole("region", { name: "Expiry radar, next 30 days" });
    expect(radar.textContent).toContain("2 plates stop alerting · 1 this week");
    expect(within(radar).getAllByRole("img")).toHaveLength(2);
  });
});
