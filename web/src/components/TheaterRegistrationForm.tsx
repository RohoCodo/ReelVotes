import { useState, type FormEvent } from "react";
import { submitTheaterRegistration } from "../lib/firebase-core";

type SubmissionStatus = "idle" | "submitting" | "done" | "error";

type SlotRow = {
  id: string;
  dayOfWeek: string;
  timeLabel: string;
  screeningDateTime: string;
  notes: string;
};

type StudioFeeRow = {
  id: string;
  studio: string;
  licensingFee: string;
  notes: string;
};

function createSlotRow(id: number): SlotRow {
  return {
    id: `slot-${id}`,
    dayOfWeek: "",
    timeLabel: "",
    screeningDateTime: "",
    notes: "",
  };
}

function createStudioFeeRow(id: number): StudioFeeRow {
  return {
    id: `studio-${id}`,
    studio: "",
    licensingFee: "",
    notes: "",
  };
}

export default function TheaterRegistrationForm() {
  const [status, setStatus] = useState<SubmissionStatus>("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const [slots, setSlots] = useState<SlotRow[]>([createSlotRow(1)]);
  const [studioFees, setStudioFees] = useState<StudioFeeRow[]>([createStudioFeeRow(1)]);

  function updateSlot(id: string, patch: Partial<SlotRow>) {
    setSlots((rows) => rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }

  function addSlot() {
    setSlots((rows) => [...rows, createSlotRow(rows.length + 1)]);
  }

  function removeSlot(id: string) {
    setSlots((rows) => (rows.length <= 1 ? rows : rows.filter((row) => row.id !== id)));
  }

  function updateStudioFee(id: string, patch: Partial<StudioFeeRow>) {
    setStudioFees((rows) => rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }

  function addStudioFee() {
    setStudioFees((rows) => [...rows, createStudioFeeRow(rows.length + 1)]);
  }

  function removeStudioFee(id: string) {
    setStudioFees((rows) => (rows.length <= 1 ? rows : rows.filter((row) => row.id !== id)));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);

    const payload = {
      contactName: String(formData.get("contactName") || "").trim(),
      contactRole: String(formData.get("contactRole") || "").trim(),
      contactEmail: String(formData.get("contactEmail") || "").trim(),
      contactPhone: String(formData.get("contactPhone") || "").trim(),
      theaterName: String(formData.get("theaterName") || "").trim(),
      website: String(formData.get("website") || "").trim(),
      ticketingEmail: String(formData.get("ticketingEmail") || "").trim(),
      addressLine1: String(formData.get("addressLine1") || "").trim(),
      addressLine2: String(formData.get("addressLine2") || "").trim(),
      city: String(formData.get("city") || "").trim(),
      state: String(formData.get("state") || "").trim(),
      postalCode: String(formData.get("postalCode") || "").trim(),
      country: String(formData.get("country") || "").trim(),
      numberOfScreens: String(formData.get("numberOfScreens") || "").trim(),
      seatingCapacity: String(formData.get("seatingCapacity") || "").trim(),
      averageTicketPrice: String(formData.get("averageTicketPrice") || "").trim(),
      typicalLicensingFee: String(formData.get("typicalLicensingFee") || "").trim(),
      programmingNotes: String(formData.get("programmingNotes") || "").trim(),
      consentToContact: formData.get("consentToContact") === "on",
      communityScreeningSlots: slots.map((slot) => ({
        dayOfWeek: slot.dayOfWeek,
        timeLabel: slot.timeLabel,
        screeningDateTime: slot.screeningDateTime,
        notes: slot.notes,
      })),
      licensingByStudio: studioFees.map((row) => ({
        studio: row.studio,
        licensingFee: row.licensingFee,
        notes: row.notes,
      })),
    };

    setStatus("submitting");
    setErrorMessage("");

    try {
      await submitTheaterRegistration(payload);
      setStatus("done");
    } catch (error) {
      setStatus("error");
      setErrorMessage(error instanceof Error ? error.message : "Could not submit your theater details. Please try again.");
    }
  }

  if (status === "done") {
    return (
      <div className="rounded-2xl border border-emerald/35 bg-emerald-soft p-6">
        <h3 className="font-display text-lg font-semibold text-ink">Thanks — we received your theater submission.</h3>
        <p className="mt-2 text-sm text-ink-soft">
          Our partnerships team will review your Community Screening Slots and follow up by email.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="grid gap-6">
      <section className="grid gap-4">
        <h3 className="font-display text-xl font-semibold text-ink">Contact</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="contactName" className="mb-1.5 block text-sm font-medium text-ink">Full name</label>
            <input id="contactName" name="contactName" type="text" required className="w-full rounded-xl border border-line bg-paper px-4 py-3 text-sm text-ink outline-none focus:border-marquee" />
          </div>
          <div>
            <label htmlFor="contactRole" className="mb-1.5 block text-sm font-medium text-ink">Role</label>
            <input id="contactRole" name="contactRole" type="text" required placeholder="Programming manager" className="w-full rounded-xl border border-line bg-paper px-4 py-3 text-sm text-ink outline-none focus:border-marquee" />
          </div>
          <div>
            <label htmlFor="contactEmail" className="mb-1.5 block text-sm font-medium text-ink">Work email</label>
            <input id="contactEmail" name="contactEmail" type="email" required className="w-full rounded-xl border border-line bg-paper px-4 py-3 text-sm text-ink outline-none focus:border-marquee" />
          </div>
          <div>
            <label htmlFor="contactPhone" className="mb-1.5 block text-sm font-medium text-ink">Phone (optional)</label>
            <input id="contactPhone" name="contactPhone" type="tel" className="w-full rounded-xl border border-line bg-paper px-4 py-3 text-sm text-ink outline-none focus:border-marquee" />
          </div>
        </div>
      </section>

      <section className="grid gap-4">
        <h3 className="font-display text-xl font-semibold text-ink">Theater details</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label htmlFor="theaterName" className="mb-1.5 block text-sm font-medium text-ink">Theater name</label>
            <input id="theaterName" name="theaterName" type="text" required className="w-full rounded-xl border border-line bg-paper px-4 py-3 text-sm text-ink outline-none focus:border-marquee" />
          </div>
          <div>
            <label htmlFor="website" className="mb-1.5 block text-sm font-medium text-ink">Website (optional)</label>
            <input id="website" name="website" type="url" placeholder="https://" className="w-full rounded-xl border border-line bg-paper px-4 py-3 text-sm text-ink outline-none focus:border-marquee" />
          </div>
          <div>
            <label htmlFor="ticketingEmail" className="mb-1.5 block text-sm font-medium text-ink">Ticketing / programming email</label>
            <input id="ticketingEmail" name="ticketingEmail" type="email" required className="w-full rounded-xl border border-line bg-paper px-4 py-3 text-sm text-ink outline-none focus:border-marquee" />
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="addressLine1" className="mb-1.5 block text-sm font-medium text-ink">Address line 1</label>
            <input id="addressLine1" name="addressLine1" type="text" required className="w-full rounded-xl border border-line bg-paper px-4 py-3 text-sm text-ink outline-none focus:border-marquee" />
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="addressLine2" className="mb-1.5 block text-sm font-medium text-ink">Address line 2 (optional)</label>
            <input id="addressLine2" name="addressLine2" type="text" className="w-full rounded-xl border border-line bg-paper px-4 py-3 text-sm text-ink outline-none focus:border-marquee" />
          </div>
          <div>
            <label htmlFor="city" className="mb-1.5 block text-sm font-medium text-ink">City</label>
            <input id="city" name="city" type="text" required className="w-full rounded-xl border border-line bg-paper px-4 py-3 text-sm text-ink outline-none focus:border-marquee" />
          </div>
          <div>
            <label htmlFor="state" className="mb-1.5 block text-sm font-medium text-ink">State / region</label>
            <input id="state" name="state" type="text" required className="w-full rounded-xl border border-line bg-paper px-4 py-3 text-sm text-ink outline-none focus:border-marquee" />
          </div>
          <div>
            <label htmlFor="postalCode" className="mb-1.5 block text-sm font-medium text-ink">Postal code</label>
            <input id="postalCode" name="postalCode" type="text" required className="w-full rounded-xl border border-line bg-paper px-4 py-3 text-sm text-ink outline-none focus:border-marquee" />
          </div>
          <div>
            <label htmlFor="country" className="mb-1.5 block text-sm font-medium text-ink">Country</label>
            <input id="country" name="country" type="text" required defaultValue="USA" className="w-full rounded-xl border border-line bg-paper px-4 py-3 text-sm text-ink outline-none focus:border-marquee" />
          </div>
          <div>
            <label htmlFor="numberOfScreens" className="mb-1.5 block text-sm font-medium text-ink">Number of screens (optional)</label>
            <input id="numberOfScreens" name="numberOfScreens" type="number" min={0} className="w-full rounded-xl border border-line bg-paper px-4 py-3 text-sm text-ink outline-none focus:border-marquee" />
          </div>
          <div>
            <label htmlFor="seatingCapacity" className="mb-1.5 block text-sm font-medium text-ink">Total seating capacity (optional)</label>
            <input id="seatingCapacity" name="seatingCapacity" type="number" min={0} className="w-full rounded-xl border border-line bg-paper px-4 py-3 text-sm text-ink outline-none focus:border-marquee" />
          </div>
        </div>
      </section>

      <section className="grid gap-4">
        <div className="flex items-end justify-between gap-3">
          <h3 className="font-display text-xl font-semibold text-ink">Community Screening Slots</h3>
          <button type="button" onClick={addSlot} className="rounded-full border border-line px-4 py-2 text-xs font-semibold text-ink hover:border-marquee hover:text-marquee">
            + Add slot
          </button>
        </div>
        <p className="text-sm text-ink-soft">Add recurring or specific windows your theater can offer for community screenings.</p>

        <div className="grid gap-4">
          {slots.map((slot, index) => (
            <div key={slot.id} className="rounded-2xl border border-line bg-cream-soft p-4">
              <div className="mb-3 flex items-center justify-between">
                <p className="text-sm font-semibold text-ink">Slot {index + 1}</p>
                <button
                  type="button"
                  onClick={() => removeSlot(slot.id)}
                  disabled={slots.length <= 1}
                  className="text-xs font-semibold text-ink-faint hover:text-rose disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Remove
                </button>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs font-medium text-ink-soft">Day of week</label>
                  <input
                    type="text"
                    value={slot.dayOfWeek}
                    onChange={(event) => updateSlot(slot.id, { dayOfWeek: event.currentTarget.value })}
                    placeholder="Tuesday"
                    className="w-full rounded-xl border border-line bg-paper px-3 py-2.5 text-sm text-ink outline-none focus:border-marquee"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-ink-soft">Time label</label>
                  <input
                    type="text"
                    value={slot.timeLabel}
                    onChange={(event) => updateSlot(slot.id, { timeLabel: event.currentTarget.value })}
                    placeholder="7:30 PM"
                    className="w-full rounded-xl border border-line bg-paper px-3 py-2.5 text-sm text-ink outline-none focus:border-marquee"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-ink-soft">Specific screening datetime (optional)</label>
                  <input
                    type="datetime-local"
                    value={slot.screeningDateTime}
                    onChange={(event) => updateSlot(slot.id, { screeningDateTime: event.currentTarget.value })}
                    className="w-full rounded-xl border border-line bg-paper px-3 py-2.5 text-sm text-ink outline-none focus:border-marquee"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="mb-1 block text-xs font-medium text-ink-soft">Notes (optional)</label>
                  <input
                    type="text"
                    value={slot.notes}
                    onChange={(event) => updateSlot(slot.id, { notes: event.currentTarget.value })}
                    placeholder="Good for repertory / no private rental conflicts"
                    className="w-full rounded-xl border border-line bg-paper px-3 py-2.5 text-sm text-ink outline-none focus:border-marquee"
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="grid gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="averageTicketPrice" className="mb-1.5 block text-sm font-medium text-ink">Average ticket price (optional)</label>
            <input id="averageTicketPrice" name="averageTicketPrice" type="number" step="0.01" min={0} className="w-full rounded-xl border border-line bg-paper px-4 py-3 text-sm text-ink outline-none focus:border-marquee" />
          </div>
          <div>
            <label htmlFor="typicalLicensingFee" className="mb-1.5 block text-sm font-medium text-ink">Typical licensing fee (optional)</label>
            <input id="typicalLicensingFee" name="typicalLicensingFee" type="number" step="0.01" min={0} className="w-full rounded-xl border border-line bg-paper px-4 py-3 text-sm text-ink outline-none focus:border-marquee" />
          </div>
        </div>

        <div className="flex items-end justify-between gap-3">
          <h3 className="font-display text-xl font-semibold text-ink">Licensing by studio (optional)</h3>
          <button type="button" onClick={addStudioFee} className="rounded-full border border-line px-4 py-2 text-xs font-semibold text-ink hover:border-marquee hover:text-marquee">
            + Add studio row
          </button>
        </div>

        {studioFees.map((row, index) => (
          <div key={row.id} className="rounded-2xl border border-line bg-cream-soft p-4">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm font-semibold text-ink">Studio row {index + 1}</p>
              <button
                type="button"
                onClick={() => removeStudioFee(row.id)}
                disabled={studioFees.length <= 1}
                className="text-xs font-semibold text-ink-faint hover:text-rose disabled:cursor-not-allowed disabled:opacity-50"
              >
                Remove
              </button>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <input
                type="text"
                value={row.studio}
                onChange={(event) => updateStudioFee(row.id, { studio: event.currentTarget.value })}
                placeholder="Studio / distributor"
                className="w-full rounded-xl border border-line bg-paper px-3 py-2.5 text-sm text-ink outline-none focus:border-marquee"
              />
              <input
                type="number"
                step="0.01"
                min={0}
                value={row.licensingFee}
                onChange={(event) => updateStudioFee(row.id, { licensingFee: event.currentTarget.value })}
                placeholder="Typical fee"
                className="w-full rounded-xl border border-line bg-paper px-3 py-2.5 text-sm text-ink outline-none focus:border-marquee"
              />
              <input
                type="text"
                value={row.notes}
                onChange={(event) => updateStudioFee(row.id, { notes: event.currentTarget.value })}
                placeholder="Notes"
                className="w-full rounded-xl border border-line bg-paper px-3 py-2.5 text-sm text-ink outline-none focus:border-marquee"
              />
            </div>
          </div>
        ))}
      </section>

      <section className="grid gap-4">
        <div>
          <label htmlFor="programmingNotes" className="mb-1.5 block text-sm font-medium text-ink">Operational notes (optional)</label>
          <textarea
            id="programmingNotes"
            name="programmingNotes"
            rows={4}
            placeholder="Anything we should know about rights workflows, hold policies, staffing constraints, or best days."
            className="w-full resize-y rounded-xl border border-line bg-paper px-4 py-3 text-sm text-ink outline-none focus:border-marquee"
          />
        </div>

        <label className="flex items-start gap-2.5 rounded-xl border border-line bg-cream-soft px-4 py-3 text-sm text-ink-soft">
          <input name="consentToContact" type="checkbox" required className="mt-0.5 h-4 w-4 rounded border-line text-marquee focus:ring-marquee" />
          <span>I confirm I represent this theater and consent to being contacted by ReelVotes about partnership setup.</span>
        </label>
      </section>

      <button
        type="submit"
        disabled={status === "submitting"}
        className="rounded-full bg-marquee px-7 py-3.5 text-sm font-semibold text-white transition-transform hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {status === "submitting" ? "Submitting…" : "Submit your theater"}
      </button>

      {status === "error" ? <p className="text-sm text-red-600">{errorMessage}</p> : null}
    </form>
  );
}
