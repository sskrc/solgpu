use anchor_lang::prelude::*;

#[error_code]
pub enum MarketError {
    #[msg("Agent URL is too long or not http(s)")]
    InvalidUrl,
    #[msg("GPU name is too long or empty")]
    InvalidGpuName,
    #[msg("Price is out of range")]
    InvalidPrice,
    #[msg("Only the listing owner can do this")]
    NotOwner,
    #[msg("Only the listing owner or its agent can do this")]
    NotOwnerOrOperator,
    #[msg("Only the listing's agent can do this")]
    NotOperator,
    #[msg("Listing is not accepting rentals")]
    ListingInactive,
    #[msg("GPU is busy")]
    ListingBusy,
    #[msg("Listing still has unsettled rentals")]
    HasOpenRentals,
    #[msg("Minutes must be between 1 and MAX_MINUTES")]
    InvalidMinutes,
    #[msg("Price changed; reload and try again")]
    PriceChanged,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Rental is not waiting to be accepted")]
    NotPending,
    #[msg("Rental is not active")]
    NotActive,
    #[msg("Accept deadline has passed")]
    AcceptDeadlinePassed,
    #[msg("Rental has not ended yet")]
    NotEnded,
    #[msg("Refund is only possible for the renter, or after the accept deadline")]
    RefundNotAllowed,
}
