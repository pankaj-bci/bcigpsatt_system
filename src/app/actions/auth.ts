"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export type ActionState = { error?: string } | undefined;

export async function getActiveEmployeeOptions() {
  const admin = createAdminClient();
  const { data } = await admin
    .from("employees")
    .select("emp_id, name")
    .eq("status", "Active")
    .order("name");
  return data ?? [];
}

export async function signupStaff(
  _prevState: ActionState,
  formData: FormData
): Promise<ActionState> {
  const empId = String(formData.get("emp_id") ?? "");
  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();
  const password = String(formData.get("password") ?? "");

  if (!empId || !email || !password) {
    return { error: "Please fill in every field." };
  }
  if (password.length < 8) {
    return { error: "Password must be at least 8 characters." };
  }

  const admin = createAdminClient();
  const { data: employee } = await admin
    .from("employees")
    .select("email, status")
    .eq("emp_id", empId)
    .maybeSingle();

  const matches =
    employee?.status === "Active" &&
    employee.email.toLowerCase() === email;

  if (!matches) {
    return {
      error:
        "That email doesn't match our records for the selected name. Contact your admin.",
    };
  }

  const { error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (error) {
    if (error.status === 422) {
      return {
        error: "An account already exists for this email — try logging in instead.",
      };
    }
    return { error: error.message };
  }

  redirect("/login?signedUp=1");
}

export async function signupAdmin(
  _prevState: ActionState,
  formData: FormData
): Promise<ActionState> {
  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) {
    return { error: "Please fill in every field." };
  }
  if (password.length < 8) {
    return { error: "Password must be at least 8 characters." };
  }

  const admin = createAdminClient();
  const { data: adminRow } = await admin
    .from("admins")
    .select("email")
    .eq("email", email)
    .maybeSingle();

  if (!adminRow) {
    return { error: "That email isn't on the admin list. Contact the app owner." };
  }

  const { error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (error) {
    if (error.status === 422) {
      return {
        error: "An account already exists for this email — try logging in instead.",
      };
    }
    return { error: error.message };
  }

  redirect("/login?signedUp=1");
}

export async function login(
  _prevState: ActionState,
  formData: FormData
): Promise<ActionState> {
  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();
  const password = String(formData.get("password") ?? "");

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    return { error: "Incorrect email or password." };
  }

  const { data: isAdmin } = await supabase.rpc("is_admin");
  if (isAdmin) {
    redirect("/admin");
  }

  const { data: employee } = await supabase
    .from("employees")
    .select("status")
    .maybeSingle();

  if (employee?.status === "Active") {
    redirect("/staff");
  }

  redirect("/access-denied");
}

export async function logout() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
