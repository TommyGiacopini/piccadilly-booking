import Image from "next/image";

export function BrandLogo({
  className = "",
  decorative = false,
  priority = false,
}: {
  className?: string;
  decorative?: boolean;
  priority?: boolean;
}) {
  return (
    <Image
      alt={decorative ? "" : "Piccadilly"}
      className={`h-auto ${className}`}
      height={257}
      priority={priority}
      sizes="(max-width: 767px) 124px, 216px"
      src="/brand/piccadilly-wordmark-white.png"
      width={730}
    />
  );
}
