import {
  noStoreJson,
  readJson,
  requireAdminMutationActor,
} from "@/app/api/admin/users/_shared";
import {
  IdentityError,
  identityErrorStatus,
} from "@/modules/identity/application/identity-errors";
import { createManagedUser } from "@/modules/identity/application/identity-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const authorization = await requireAdminMutationActor(request);
  if (authorization.response) return authorization.response;

  try {
    const result = await createManagedUser(
      {
        id: authorization.user.id,
        restaurantId: authorization.user.restaurantId,
      },
      await readJson(request),
    );

    return noStoreJson(result, 201);
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

    console.error("User creation failed.");
    return noStoreJson({ error: "Non è stato possibile creare l'utente." }, 500);
  }
}
