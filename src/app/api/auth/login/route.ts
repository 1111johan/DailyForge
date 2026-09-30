import { NextResponse } from "next/server";
import { z } from "zod";
import { getSecret } from "@/lib/config/env";
import { routeError } from "@/lib/http/route-error";
import {
  adminCookie,
  createAdminSession,
} from "@/lib/security/admin-session";
import { secretsMatch, UnauthorizedError } from "@/lib/security/verify-secret";

const LoginSchema = z.object({ accessKey: z.string().min(1).max(512) });

export async function POST(request: Request) {
  try {
    const parsed = LoginSchema.safeParse(await request.json());
    if (
      !parsed.success ||
      !secretsMatch(parsed.data.accessKey, getSecret("ADMIN_ACCESS_KEY"))
    ) {
      throw new UnauthorizedError();
    }
    const response = NextResponse.json({ ok: true });
    response.headers.set(
      "Set-Cookie",
      adminCookie(createAdminSession(), request),
    );
    return response;
  } catch (error) {
    return routeError(error);
  }
}
