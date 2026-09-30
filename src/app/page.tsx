import { cookies } from "next/headers";
import { Dashboard } from "@/components/dashboard";
import { LoginScreen } from "@/components/login-screen";
import {
  ADMIN_SESSION_COOKIE,
  verifyAdminSession,
} from "@/lib/security/admin-session";

export default async function HomePage() {
  const cookieStore = await cookies();
  const authenticated = verifyAdminSession(
    cookieStore.get(ADMIN_SESSION_COOKIE)?.value,
  );
  return authenticated ? <Dashboard /> : <LoginScreen />;
}
