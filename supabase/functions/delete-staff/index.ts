import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, isAllowedOrigin, rejectOrigin } from "../_shared/cors.ts";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type PrepareResult = { operation_id?: unknown };
type LookupResult = { status?: string; operation_id?: unknown; operation_status?: string };
type DeletionResult = { operation_id?: string; email?: string | null; auth_account_deleted?: boolean; profile_removed?: boolean };
type RecoveryResult = DeletionResult & { status?: string };
type AbortResult = DeletionResult & { status?: string };
type FinalizeResult = DeletionResult & { status?: string };
type RecoverTargetResult = {
  lookupError?: string;
  recoveryError?: string;
  lookupStatus?: string;
  operationId?: string;
  recovery?: RecoveryResult | null;
};

function prepareFailure(message: string) {
  if (message.includes("already been finalized")) return { status: 409, error: "This staff account has already been deleted." };
  if (message.includes("already in progress")) return { status: 409, error: "A staff deletion is already in progress for this account." };
  if (message.includes("Staff profile not found")) return { status: 404, error: "Staff account not found" };
  if (message.includes("last active SuperAdmin")) return { status: 409, error: "Cannot delete the last active SuperAdmin." };
  if (message.includes("Active SuperAdmin required")) return { status: 403, error: "SuperAdmin access required" };
  if (message.includes("own account")) return { status: 400, error: "You cannot delete your own account" };
  return { status: 500, error: "Staff deletion could not be prepared. Check the function logs." };
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin") ?? "";
  if (!isAllowedOrigin(origin)) return rejectOrigin(origin);
  const headers = corsHeaders(origin);
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...headers, "Content-Type": "application/json" } });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const url = Deno.env.get("SUPABASE_URL"), anon = Deno.env.get("SUPABASE_ANON_KEY"), service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !anon || !service) return json({ error: "Server configuration incomplete" }, 500);
    const authorization = req.headers.get("Authorization");
    if (!authorization?.startsWith("Bearer ")) return json({ error: "Authentication required" }, 401);

    const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
    const client = createClient(url, anon, { global: { headers: { Authorization: authorization } }, auth: { persistSession: false, autoRefreshToken: false } });
    const { data: userData, error: userError } = await client.auth.getUser();
    const actor = userData.user;
    if (userError || !actor) return json({ error: "Invalid session" }, 401);

    const { data: actorProfile, error: actorProfileError } = await admin.from("staff_profiles").select("user_id").eq("user_id", actor.id).eq("active", true).maybeSingle();
    const { data: actorRoles, error: actorRolesError } = await admin.from("staff_role_assignments").select("role").eq("user_id", actor.id).eq("active", true);
    if (actorProfileError || actorRolesError) {
      console.error("delete-staff permission query failed", {
        profileError: actorProfileError?.message,
        rolesError: actorRolesError?.message,
      });
      return json({ error: "Could not verify staff permissions" }, 500);
    }
    if (!actorProfile || !actorRoles?.some((role) => role.role === "superadmin")) return json({ error: "SuperAdmin access required" }, 403);

    const body = await req.json();
    const targetId = String(body?.target_user_id ?? "");
    if (!uuidPattern.test(targetId)) return json({ error: "Valid target user ID required" }, 400);
    if (targetId === actor.id) return json({ error: "You cannot delete your own account" }, 400);

    const { data: targetProfile, error: targetProfileError } = await admin
      .from("staff_profiles")
      .select("user_id, full_name, email, active")
      .eq("user_id", targetId)
      .maybeSingle();
    if (targetProfileError) {
      console.error("delete-staff target profile query failed", { targetId, message: targetProfileError.message });
      return json({ error: "Could not inspect the target staff profile" }, 500);
    }

    const { data: authData, error: authError } = await admin.auth.admin.getUserById(targetId);
    const targetAuthUser = authError ? null : authData?.user ?? null;
    if (authError && authError.status !== 404 && authError.code !== "user_not_found") {
      console.error("delete-staff target auth query failed", { targetId, message: authError.message });
      return json({ error: "Could not inspect the target Auth account" }, 500);
    }

    const targetEmail = targetAuthUser?.email ?? targetProfile?.email ?? null;

    const callFind = () => admin.rpc("find_staff_deletion_operation", {
      p_actor_user_id: actor.id,
      p_target_user_id: targetId,
    });

    const callRecover = (operationId: string) => admin.rpc("recover_staff_deletion", {
      p_operation_id: operationId,
      p_actor_user_id: actor.id,
      p_target_user_id: targetId,
    });

    const callPrepare = () => admin.rpc("prepare_staff_deletion", {
      p_actor_user_id: actor.id,
      p_target_user_id: targetId,
    });

    const callAbort = (operationId: string) => admin.rpc("abort_staff_deletion", {
      p_operation_id: operationId,
      p_actor_user_id: actor.id,
      p_target_user_id: targetId,
    });

    const callFinalize = (operationId: string) => admin.rpc("finalize_staff_deletion", {
      p_operation_id: operationId,
      p_actor_user_id: actor.id,
      p_target_user_id: targetId,
    });

    const deletionResponse = (result: DeletionResult | null, alreadyDeleted = false) => json({
      success: true,
      ...(result?.operation_id ? { operation_id: result.operation_id } : {}),
      email: result?.email ?? targetEmail,
      auth_account_deleted: Boolean(result?.auth_account_deleted),
      database_cleaned: true,
      ...(alreadyDeleted ? { already_deleted: true } : {}),
    });

    const recoverTargetOperation = async (): Promise<RecoverTargetResult> => {
      const { data: lookupData, error: lookupError } = await callFind();
      if (lookupError) return { lookupError: lookupError.message };
      const lookup = lookupData as LookupResult | null;
      if (lookup?.status === "not_found" || !lookup?.operation_id) return { lookupStatus: lookup?.status ?? "not_found" };
      const operationId = String(lookup.operation_id);
      if (!uuidPattern.test(operationId)) return { lookupError: "Invalid operation ID returned by lookup" };
      const { data: recoveryData, error: recoveryError } = await callRecover(operationId);
      if (recoveryError) return { recoveryError: recoveryError.message };
      return { operationId, recovery: recoveryData as RecoveryResult | null };
    };

    if (!targetProfile) {
      const recovered = await recoverTargetOperation();
      if (recovered.lookupError) {
        console.error("delete-staff operation lookup failed", { targetId, message: recovered.lookupError });
        return json({ error: "Staff account cleanup could not be completed" }, 500);
      }
      if (recovered.recoveryError) {
        console.error("delete-staff recovery failed", { targetId, operationId: recovered.operationId, message: recovered.recoveryError });
        return json({ error: "Staff account cleanup could not be completed" }, 500);
      }
      if (recovered.lookupStatus === "not_found") return json({ error: "Staff account not found" }, 404);
      const recovery = recovered.recovery;
      if (!recovery) {
        console.error("delete-staff recovery returned no result", { targetId, operationId: recovered.operationId });
        return json({ error: "Staff account cleanup could not be completed" }, 500);
      }
      if (recovery.status === "finalized" || recovery.status === "already_finalized") return deletionResponse(recovery, true);
      if (recovery.status === "aborted" || recovery.status === "not_found") return json({ error: "Staff account not found" }, 404);
      if (recovery.status === "auth_present" || recovery.status === "state_uncertain" || recovery.status === "last_superadmin") {
        return json({ error: "Staff deletion requires manual review; the operation reservation was preserved." }, 409);
      }
      console.error("delete-staff recovery returned an unexpected state", { targetId, operationId: recovered.operationId, status: recovery.status });
      return json({ error: "Staff account cleanup could not be completed" }, 500);
    }

    let operationId = "";
    let prepareResult = await callPrepare();

    if (prepareResult.error?.message.includes("already in progress")) {
      const recovered = await recoverTargetOperation();
      if (recovered.lookupError) {
        console.error("delete-staff conflict lookup failed", { targetId, message: recovered.lookupError });
        return json({ error: "A staff deletion is already in progress and its operation could not be inspected. Check the function logs." }, 500);
      }
      if (recovered.recoveryError) {
        console.error("delete-staff conflict recovery failed", { targetId, operationId: recovered.operationId, message: recovered.recoveryError });
        return json({ error: "A staff deletion is already in progress and its recovery check failed. Check the function logs." }, 500);
      }
      if (recovered.lookupStatus === "not_found") {
        prepareResult = await callPrepare();
      } else {
        const recovery = recovered.recovery;
        if (!recovery) {
          console.error("delete-staff conflict recovery returned no result", { targetId, operationId: recovered.operationId });
          return json({ error: "A staff deletion is already in progress and its operation state is unknown. Check the function logs." }, 500);
        }
        if (recovery.status === "finalized" || recovery.status === "already_finalized") return deletionResponse(recovery, true);
        if (recovery.status === "auth_present") {
          operationId = recovered.operationId ?? "";
          if (!uuidPattern.test(operationId)) {
            console.error("delete-staff conflict recovery returned no valid operation ID", { targetId });
            return json({ error: "Staff deletion recovery returned an invalid operation ID. Manual review is required." }, 500);
          }
        } else if (recovery.status === "state_uncertain") {
          return json({ error: "A staff deletion is already in progress; its state is uncertain and the operation reservation was preserved. Manual review is required." }, 409);
        } else if (recovery.status === "last_superadmin") {
          return json({ error: "Deletion cannot resume because it would remove the last active SuperAdmin; the operation reservation was preserved." }, 409);
        } else if (recovery.status === "aborted" || recovery.status === "not_found") {
          prepareResult = await callPrepare();
        } else {
          console.error("delete-staff conflict recovery returned an unexpected state", { targetId, operationId: recovered.operationId, status: recovery.status });
          return json({ error: "Staff deletion could not be prepared. Check the function logs." }, 500);
        }
      }
    }

    if (!operationId) {
      if (prepareResult.error) {
        console.error("delete-staff preparation failed", { targetId, message: prepareResult.error.message });
        const failure = prepareFailure(prepareResult.error.message);
        return json({ error: failure.error }, failure.status);
      }

      operationId = String((prepareResult.data as PrepareResult | null)?.operation_id ?? "");
      if (!uuidPattern.test(operationId)) {
        console.error("delete-staff preparation returned no valid operation ID", { targetId });
        return json({ error: "Staff deletion could not be prepared. Check the function logs." }, 500);
      }
    }

    const { data: preDeleteData, error: preDeleteError } = await callRecover(operationId);
    if (preDeleteError) {
      console.error("delete-staff pre-delete recovery failed", { targetId, operationId, message: preDeleteError.message });
      return json({ error: "The staff deletion could not be revalidated. The operation reservation was preserved; manual review is required." }, 500);
    }

    const preDelete = preDeleteData as RecoveryResult | null;
    if (!preDelete) {
      console.error("delete-staff pre-delete recovery returned no result", { targetId, operationId });
      return json({ error: "The staff deletion could not be revalidated. The operation reservation was preserved; manual review is required." }, 500);
    }

    if (preDelete.status === "finalized" || preDelete.status === "already_finalized") {
      return deletionResponse(preDelete, true);
    }
    if (preDelete.status === "state_uncertain") {
      return json({ error: "The staff profile or role state changed before Auth deletion. The operation reservation was preserved; manual review is required." }, 409);
    }
    if (preDelete.status === "last_superadmin") {
      return json({ error: "Deletion stopped because it would remove the last active SuperAdmin. The operation reservation was preserved." }, 409);
    }
    if (preDelete.status === "aborted" || preDelete.status === "not_found") {
      return json({ error: "The staff deletion operation is no longer prepared. Retry the deletion or check the function logs." }, 409);
    }
    if (preDelete.status !== "auth_present") {
      console.error("delete-staff pre-delete recovery returned an unexpected state", { targetId, operationId, status: preDelete.status });
      return json({ error: "The staff deletion could not be revalidated. The operation reservation was preserved; manual review is required." }, 500);
    }

    const { error: deleteError } = await admin.auth.admin.deleteUser(targetId, false);
    const authAlreadyGone = Boolean(deleteError && (deleteError.status === 404 || deleteError.code === "user_not_found"));
    if (deleteError && !authAlreadyGone) {
      console.error("delete-staff auth deletion failed", { targetId, operationId, message: deleteError.message });
      const { data: abortData, error: abortError } = await callAbort(operationId);
      const abort = abortData as AbortResult | null;
      if (abortError) {
        console.error("delete-staff abort failed", { targetId, operationId, message: abortError.message });
        return json({ error: "Auth account deletion failed and the operation reservation could not be released. Manual review is required." }, 500);
      }
      if (abort?.status === "already_finalized") return deletionResponse(abort, true);
      if (abort?.status === "released" || abort?.status === "already_aborted") {
        return json({ error: "Auth account deletion failed; the deletion operation was released. Check the function logs before retrying." }, 500);
      }
      if (abort?.status === "state_uncertain") {
        return json({ error: "Auth account deletion failed and the deletion state is uncertain. The operation reservation was preserved; manual review is required." }, 500);
      }
      if (abort?.status !== "auth_missing") {
        console.error("delete-staff abort returned an unexpected state", { targetId, operationId, status: abort?.status });
        return json({ error: "Auth account deletion failed and the operation state is unknown. Manual review is required." }, 500);
      }
    }

    const { data: finalizeData, error: finalizeError } = await callFinalize(operationId);
    if (finalizeError) {
      console.error("delete-staff finalize failed", { targetId, operationId, message: finalizeError.message });
      return json({
        error: "The Auth account state was updated, but directory cleanup or audit finalization failed. Retry this deletion so recovery can complete it, and do not re-invite this email until then.",
      }, 500);
    }

    const finalization = finalizeData as FinalizeResult | null;
    if (!finalization) {
      console.error("delete-staff finalize returned no result", { targetId, operationId });
      return json({ error: "Staff deletion finalization returned an unknown state. Manual review is required." }, 500);
    }
    if (finalization.status === "finalized" || finalization.status === "already_finalized") {
      return deletionResponse(finalization, finalization.status === "already_finalized");
    }
    if (finalization.status === "auth_present") {
      return json({ error: "The Auth account still exists; deletion was not finalized and the operation reservation was preserved." }, 409);
    }
    if (finalization.status === "last_superadmin") {
      return json({ error: "Finalization stopped because it would remove the last active SuperAdmin. The operation reservation was preserved; manual review is required." }, 409);
    }
    if (finalization.status === "aborted") {
      return json({ error: "The deletion operation was aborted and cannot be finalized." }, 409);
    }
    console.error("delete-staff finalize returned an unexpected state", { targetId, operationId, status: finalization.status });
    return json({ error: "Staff deletion finalization returned an unknown state. Manual review is required." }, 500);
  } catch (error) {
    console.error("delete-staff unexpected error", error);
    return json({ error: "Unexpected server error" }, 500);
  }
});
