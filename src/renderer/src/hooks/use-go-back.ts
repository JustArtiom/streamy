import { useLocation, useNavigate } from "react-router";

/**
 * The title bar's Back: like the browser's back button, except when there's
 * nothing to go back to in Streamy (the window opened on this page, e.g.
 * after a reload): then it goes Home.
 */
export function useGoBack(): () => void {
  const navigate = useNavigate();
  const location = useLocation();
  // React Router gives the first page of a window the key "default"; every
  // page reached by navigating gets its own key.
  const hasHistory = location.key !== "default";

  return () => {
    if (hasHistory) void navigate(-1);
    else void navigate("/", { replace: true });
  };
}
