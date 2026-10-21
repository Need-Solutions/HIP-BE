import { z } from "zod";
import { normalisePhone } from "../../users/validators/auth.validator";

const code = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^HIP-[A-Z0-9]{4}-[A-Z0-9]{4}$/, "Ticket IDs look like HIP-7Q4K-2291");
export const ticketParams = z.object({ code });
export const ticketQuery = z.object({
  token: z.string().max(256).optional(),
});
export const guestLinkSchema = z
  .object({
    contact: z
      .string()
      .trim()
      .min(1)
      .max(254)
      .transform((value) =>
        value.includes("@") ? value.toLowerCase() : normalisePhone(value),
      )
      .refine(
        (value) =>
          z.string().email().safeParse(value).success ||
          /^(?:\+?234|0)[789][01]\d{8}$/.test(value) ||
          /^\+[1-9]\d{7,14}$/.test(value),
        "Enter a valid email address or phone number",
      ),
    code: code.optional(),
  })
  .strict();
