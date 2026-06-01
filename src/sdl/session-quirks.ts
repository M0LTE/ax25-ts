/**
 * Per-session toggles for deliberate, documented deviations from the AX.25
 * SDL figures, used where a figure is a confirmed upstream spec defect.
 *
 * This is the session-layer analogue of wire-parse pragmatism options: the
 * SDL tables themselves (`ax25sdl`, from `m0lte/ax25sdl`) stay faithful to
 * the published figures — including their defects — so the canonical
 * transcription tracks the in-progress draft. Where a figure is provably
 * wrong, the runtime corrects it here, behind a named flag, rather than
 * diverging the tables.
 *
 * Philosophy mirrors the C# `Ax25SessionQuirks` record (m0lte/packet.net):
 * the {@link defaultSessionQuirks} preset does the spec-*correct* thing so
 * the stack works out of the box; {@link strictlyFaithfulSessionQuirks}
 * turns every quirk off, reproducing the figures exactly as drawn (defects
 * and all) for strict conformance testing.
 *
 * **Pattern for adding a quirk** (replicable): name the flag
 * `ax25Spec<issue>…` after the `packethacking/ax25spec` issue it works
 * around — so it is greppable and removable once the spec is fixed —
 * default it to the corrected behaviour, document the spec prose + the
 * de-facto implementation evidence, and open a tracking issue to delete
 * it when `ax25sdl` ships a figure carrying the upstream resolution.
 */
export interface Ax25SessionQuirks {
  /**
   * Work around `packethacking/ax25spec#38`: figc4.5 (Timer Recovery)
   * draws the SREJ-received retransmit path as the generic fresh-DL-DATA
   * "Push frame onto queue" verb followed by "Invoke Retransmission"
   * (go-back-N). That contradicts §4.3.2.4 / §6.4.8 ("retransmission of
   * the *single* I frame numbered N(R) … frames transmitted following …
   * are not retransmitted"), figc4.4's correct SREJ handler, and every
   * surveyed implementation (direwolf and linbpq do single-frame
   * selective; linux and rax25 don't implement SREJ-driven go-back-N at
   * all). direwolf's author independently flagged the exact box as a
   * "2006 revision … cut-n-paste from the REJ flow chart" and disabled it.
   *
   * When `true` (default), an SREJ-received transition does single-frame
   * selective retransmit — it redirects the figure's "Push frame onto
   * queue" to the figc4.4 "Push Old I Frame N(r) on Queue" behaviour and
   * skips the go-back-N "Invoke Retransmission". When `false`, the
   * figc4.5 figure runs as drawn (which also throws on the payload-less
   * push — strict conformance only). Delete this quirk once `ax25sdl`
   * ships a corrected figc4.5.
   *
   * Mirrors `Ax25SessionQuirks.Ax25Spec38SrejSelectiveRetransmit` in
   * m0lte/packet.net (PR #228).
   */
  ax25Spec38SrejSelectiveRetransmit: boolean;
}

/**
 * Default preset — spec-*correct* behaviour (all quirks on). This is what
 * a session uses unless explicitly configured otherwise. Mirrors
 * `Ax25SessionQuirks.Default` in m0lte/packet.net.
 */
export const defaultSessionQuirks: Ax25SessionQuirks = {
  ax25Spec38SrejSelectiveRetransmit: true,
};

/**
 * Every quirk off — execute the SDL figures exactly as drawn, including
 * known defects. For strict conformance testing against the published
 * figures, not for on-air use. Mirrors `Ax25SessionQuirks.StrictlyFaithful`
 * in m0lte/packet.net.
 */
export const strictlyFaithfulSessionQuirks: Ax25SessionQuirks = {
  ax25Spec38SrejSelectiveRetransmit: false,
};
