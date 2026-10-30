// A stand-in for navigator.userActivation, defined before @ermine/system loads. Tests set
// `userActivation.active`.
export const userActivation: { active: boolean } = { active: false }
class UserActivation {
	get isActive() {
		return userActivation.active
	}
	get hasBeenActive() {
		return userActivation.active
	}
}
Object.defineProperty(globalThis, "UserActivation", { value: UserActivation, configurable: true })
Object.defineProperty(globalThis.navigator, "userActivation", {
	value: new UserActivation(),
	configurable: true,
})
