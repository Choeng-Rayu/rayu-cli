// A single-file Rust test to verify the toolchain works.
// Run with: rustc --test test.rs -o test_bin && ./test_bin
// Or just:  rustc test.rs -o test_bin && ./test_bin

fn add(a: i64, b: i64) -> i64 {
    a + b
}

fn multiply(a: i64, b: i64) -> i64 {
    a * b
}

fn main() {
    println!("Rust toolchain test");
    println!("add(2, 3)      = {}", add(2, 3));
    println!("multiply(4, 5) = {}", multiply(4, 5));
    assert_eq!(add(2, 3), 5);
    assert_eq!(multiply(4, 5), 20);
    println!("All runtime assertions passed.");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_works() {
        assert_eq!(add(1, 1), 2);
        assert_eq!(add(-1, 1), 0);
    }

    #[test]
    fn multiply_works() {
        assert_eq!(multiply(0, 99), 0);
        assert_eq!(multiply(7, 6), 42);
    }
}