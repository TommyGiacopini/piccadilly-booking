import {
  noStoreJson,
  readJson,
  requireAdminMutationActor,
} from "@/app/api/admin/users/_shared";
import {
  IdentityError,
  identityErrorStatus,
} from "@/modules/identity/application/identity-errors";
import { changeManagedUserRole } from "@/modules/identity/application/identity-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const authorization = await requireAdminMutationActor(request);
  if (authorization.response) return authorization.response;

  try {
    const { id } = await context.params;
    const result = await changeManagedUserRole(
      {
        id: authorization.user.id,
        restaurantId: authorization.user.restaurantId,
      },
      id,
      await readJson(request),
    );
    return noStoreJson(result, 200);
  } catch (error) {
    if (error instanceof IdentityError) {
      return noStoreJson(
        { error: error.publicMessage, code: error.code },
        identityErrorStatus(error.code),
      );
    }

    if (error instanceof SyntaxError || error instanceof TypeError) {
      return noStoreJson({ error: "Il corpo JSON non è valido." }, 400);
    }

    console.error("User role change failed.");
    return noStoreJson({ error: "Non è stato possibile cambiare il ruolo." }, 500);
  }
}
