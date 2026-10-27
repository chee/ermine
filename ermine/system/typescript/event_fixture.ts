// a stand-in for the browser's navigator.userActivation, defined before @ermine/system loads
// (useractivation.ts keeps the getter and the object then): tests set `userActivation.active` to say
// whether a person just interacted with the page
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
