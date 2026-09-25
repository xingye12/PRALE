from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class RetryPolicy:
    max_attempts: int = 3
    base_delay_ms: int = 250
    max_delay_ms: int = 5_000

    def delay_ms(self, next_attempt: int) -> int:
        if next_attempt < 2:
            return 0
        return min(self.base_delay_ms * (2 ** (next_attempt - 2)), self.max_delay_ms)
