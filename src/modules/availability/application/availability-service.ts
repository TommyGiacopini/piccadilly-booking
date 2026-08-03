import "server-only";

import { AvailabilityApplicationError } from "@/modules/availability/application/availability-errors";
import { calculateAvailability } from "@/modules/availability/domain/availability-engine";
import { getLocalDayOfWeek } from "@/modules/availability/domain/local-calendar";
import type {
  AvailabilityChannel,
  AvailabilityConfigurationInput,
  AvailabilityResult,
  AvailabilityServiceType,
} from "@/modules/availability/domain/types";
import { readAvailabilityConfiguration } from "@/modules/availability/infrastructure/availability-repository";
import { isLocalDate } from "@/modules/configuration/domain/operational-time";

export interface AvailabilityConfigurationRepository {
  read(input: {
    restaurantId: string;
    date: string;
    dayOfWeek: ReturnType<typeof getLocalDayOfWeek>;
    serviceType: AvailabilityServiceType;
  }): Promise<AvailabilityConfigurationInput | null>;
}

const prismaAvailabilityConfigurationRepository: AvailabilityConfigurationRepository = {
  read: readAvailabilityConfiguration,
};

export interface GetAvailabilityPreviewInput {
  restaurantId: string;
  date: string;
  serviceType: AvailabilityServiceType;
  partySize: number;
  channel: AvailabilityChannel;
  now: Date;
}

export async function getAvailabilityPreview(
  input: GetAvailabilityPreviewInput,
  dependencies: {
    repository?: AvailabilityConfigurationRepository;
  } = {},
): Promise<AvailabilityResult> {
  if (!isLocalDate(input.date)) {
    throw new AvailabilityApplicationError(
      "VALIDATION",
      "La data richiesta non è valida.",
    );
  }

  const repository =
    dependencies.repository ?? prismaAvailabilityConfigurationRepository;
  const configuration = await repository.read({
    restaurantId: input.restaurantId,
    date: input.date,
    dayOfWeek: getLocalDayOfWeek(input.date),
    serviceType: input.serviceType,
  });

  if (!configuration) {
    throw new AvailabilityApplicationError(
      "NOT_FOUND",
      "La configurazione operativa del ristorante non è disponibile.",
    );
  }

  return calculateAvailability({
    date: input.date,
    serviceType: input.serviceType,
    partySize: input.partySize,
    now: input.now,
    channel: input.channel,
    configuration,
    // Reservation does not exist yet. Persistent load will be read and
    // rechecked transactionally by the future reservation milestone.
    arrivals: [],
  });
}
