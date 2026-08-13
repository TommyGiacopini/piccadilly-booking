import {
  noStoreJson,
  requireAdminMutationActor,
} from "@/app/api/admin/users/_shared";
import {
  IdentityError,
  identityErrorStatus,
} from "@/modules/identity/application/identity-errors";
import { resetManagedUserPassword } from "@/modules/identity/application/identity-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const authorization = await requireAdminMutationActor(request);
  if (authorization.response) return authorization.response;

  try {
    const { id } = await context.params;
    const result = await resetManagedUserPassword(
      {
        id: authorization.user.id,
        restaurantId: authorization.user.restaurantId,
      },
      id,
    );
    return noStoreJson(result, 200);
  } catch (error) {
    if (error instanceof IdentityError) {
      return noStoreJson(
        { error: error.publicMessage, code: error.code },
        identityErrorStatus(error.code),
      );
    }

    console.error("User password reset failed.");
    return noStoreJson({ error: "Non è stato possibile reimpostare la password." }, 500);
  }
}
