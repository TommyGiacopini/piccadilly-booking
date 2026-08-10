import "server-only";

import { AvailabilityApplicationError } from "@/modules/availability/application/availability-errors";
import { calculateAvailability } from "@/modules/availability/domain/availability-engine";
import { getLocalDayOfWeek } from "@/modules/availability/domain/local-calendar";
import type {
  AvailabilityChannel,
  AvailabilityConfigurationInput,
  AvailabilityResult,
  AvailabilityServiceType,
  CapacityArrival,
} from "@/modules/availability/domain/types";
import {
  readAvailabilityArrivals,
  readAvailabilityConfiguration,
} from "@/modules/availability/infrastructure/availability-repository";
import { isLocalDate } from "@/modules/configuration/domain/operational-time";

export interface AvailabilityConfigurationRepository {
  read(input: {
    restaurantId: string;
    date: string;
    dayOfWeek: ReturnType<typeof getLocalDayOfWeek>;
    serviceType: AvailabilityServiceType;
  }): Promise<AvailabilityConfigurationInput | null>;
}

export interface AvailabilityArrivalsRepository {
  read(input: {
    restaurantId: string;
    date: string;
    serviceType: AvailabilityServiceType;
  }): Promise<CapacityArrival[]>;
}

const prismaAvailabilityConfigurationRepository: AvailabilityConfigurationRepository = {
  read: readAvailabilityConfiguration,
};

const prismaAvailabilityArrivalsRepository: AvailabilityArrivalsRepository = {
  read: readAvailabilityArrivals,
};

export interface GetAvailabilityPreviewInput {
  restaurantId: string;
  date: string;
  serviceType: AvailabilityServiceType;
  partySize: number;
  channel: AvailabilityChannel;
  now: Date;
  includePersistentLoad?: boolean;
}

export async function getAvailabilityPreview(
  input: GetAvailabilityPreviewInput,
  dependencies: {
    repository?: AvailabilityConfigurationRepository;
    arrivalsRepository?: AvailabilityArrivalsRepository;
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

  const arrivals = input.includePersistentLoad
    ? await (
        dependencies.arrivalsRepository ??
        prismaAvailabilityArrivalsRepository
      ).read({
        restaurantId: input.restaurantId,
        date: input.date,
        serviceType: input.serviceType,
      })
    : [];

  return calculateAvailability({
    date: input.date,
    serviceType: input.serviceType,
    partySize: input.partySize,
    now: input.now,
    channel: input.channel,
    configuration,
    arrivals,
  });
}
