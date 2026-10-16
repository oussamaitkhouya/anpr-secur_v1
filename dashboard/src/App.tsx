import { RouterProvider } from "react-router";
import { QueryProvider } from "./app/QueryProvider";
import { SessionProvider } from "./app/SessionProvider";
import { router } from "./app/routes";
import { ToastProvider } from "./components/ui/ToastProvider";

export default function App() {
  return (
    <SessionProvider>
      <QueryProvider>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </QueryProvider>
    </SessionProvider>
  );
}
